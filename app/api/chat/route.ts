import {
  ApiError,
  GoogleGenAI,
  type Content,
  type GenerateContentConfig,
} from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { traceable } from "langsmith/traceable";
import { wrapGemini } from "langsmith/wrappers/gemini";
import {
  currentRunId,
  flushTracesAfterResponse,
  traceConfig,
  traceHeaders,
} from "@/app/lib/tracing";

export const runtime = "nodejs";
// A document question makes a backend search plus a Gemini call (with retries).
export const maxDuration = 60;

// Keep this in sync with MODELS in app/components/Chat.tsx
const ALLOWED_MODELS = new Set([
  "gemini-3.6-flash",
  "gemini-3-flash-preview",
  "gemini-3.5-flash",
  "gemini-2.5-flash",
  "gemini-3.5-flash-lite",
]);
const DEFAULT_MODEL = "gemini-3-flash-preview";

// 503 ("model currently experiencing high demand") is Google's own
// documented transient error — it typically clears within seconds. Retry a
// couple of times with backoff before surfacing it. Deliberately NOT
// retrying 429: that can mean genuine rate limiting, but for a free-tier key
// with a hard quota of 0 it means every retry would fail identically after
// wasting several seconds each, for no benefit.
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1500];

async function generateWithRetry(
  ai: GoogleGenAI,
  model: string,
  contents: Content[],
  config: GenerateContentConfig
) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await ai.models.generateContent({ model, contents, config });
    } catch (error) {
      const isRetryable =
        error instanceof ApiError && error.status === 503 && !config.abortSignal?.aborted;
      if (!isRetryable || attempt === MAX_ATTEMPTS) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1])
      );
    }
  }
  // Unreachable: the loop above always either returns or throws.
  throw new Error("generateWithRetry: exhausted attempts without a result");
}

// Never forward the client's generationConfig as-is: clamp every field to
// Gemini's documented valid range and drop anything not explicitly
// recognized, so a malformed or malicious payload can't send unexpected
// fields or extreme values to the upstream API.
function sanitizeGenerationConfig(input: unknown): GenerateContentConfig {
  if (typeof input !== "object" || input === null) return {};
  const raw = input as Record<string, unknown>;
  const config: GenerateContentConfig = {};

  const clampedNumber = (value: unknown, min: number, max: number): number | undefined => {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return Math.min(max, Math.max(min, value));
  };

  const temperature = clampedNumber(raw.temperature, 0, 2);
  if (temperature !== undefined) config.temperature = temperature;

  const topK = clampedNumber(raw.topK, 1, 1000);
  if (topK !== undefined) config.topK = Math.round(topK);

  const topP = clampedNumber(raw.topP, 0, 1);
  if (topP !== undefined) config.topP = topP;

  const maxOutputTokens = clampedNumber(raw.maxOutputTokens, 1, 65536);
  if (maxOutputTokens !== undefined) config.maxOutputTokens = Math.round(maxOutputTokens);

  // Gemini documents this range as [-2.0, 2.0], but the live API actually
  // enforces a half-open interval — exactly 2.0 is rejected with
  // "frequency_penalty must be in the range [-2.0, 2.0)" (confirmed via a
  // direct test call). Clamp just under 2 so the slider's max position never
  // gets rejected.
  const PENALTY_MAX = 1.99;

  const frequencyPenalty = clampedNumber(raw.frequencyPenalty, -2, PENALTY_MAX);
  if (frequencyPenalty !== undefined) config.frequencyPenalty = frequencyPenalty;

  const presencePenalty = clampedNumber(raw.presencePenalty, -2, PENALTY_MAX);
  if (presencePenalty !== undefined) config.presencePenalty = presencePenalty;

  const seed = clampedNumber(raw.seed, -2147483648, 2147483647);
  if (seed !== undefined) config.seed = Math.round(seed);

  if (Array.isArray(raw.stopSequences)) {
    const stopSequences = raw.stopSequences
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.slice(0, 100))
      .slice(0, 5);
    if (stopSequences.length > 0) config.stopSequences = stopSequences;
  }

  return config;
}

// The backend's hybrid (dense + sparse dotproduct) scores are unbounded —
// observed 4–14 for relevant pages and 1–4 for unrelated questions — so this
// threshold filters almost nothing. The grounded prompt's "I don't know" rule
// is what actually rejects irrelevant context.
const MIN_SCORE = 0.15;
const TOP_K = 4;
const NO_ANSWER = "I don't know — the provided documents don't cover this.";

const GROUNDED = `You are answering questions about the user's uploaded document.

Use ONLY the CONTEXT below. If it does not contain the answer, reply with exactly:
"${NO_ANSWER}"
Answer concisely, quoting figures and defined terms verbatim.
If the context only partially answers, answer what is supported and state what is missing.
If two chunks conflict, point out the conflict and cite both.
Cite the filename and page for every claim, using ONLY the page from the
[filename, page N] label above each chunk. Ignore page numbers printed inside
the text itself (such as document footers) — they do not match the PDF pages.
Never invent numbers or sources.`;

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface RetrievedChunk {
  text: string;
  filename: string;
  page: number;
  doc_id: string;
  score: number;
}

// Document ids are opaque strings from the backend; this only rejects
// anything that couldn't be one before it's forwarded.
const DOC_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// Only the most recent messages go to Gemini, so an unrelated exchange from
// earlier in a long chat doesn't cost tokens on every request or sway answers.
// A question referring further back than this won't have that context.
const MAX_HISTORY = 6;

function recentHistory(history: ChatMessage[]): ChatMessage[] {
  const recent = history.slice(-MAX_HISTORY);
  // Gemini expects the conversation to open with a user turn; the cut can land
  // on a reply (e.g. after a stopped, unanswered question shifts the pairing).
  const firstUser = recent.findIndex((m) => m.role === "user");
  return firstUser === -1 ? [] : recent.slice(firstUser);
}

const toContents = (messages: ChatMessage[]): Content[] =>
  messages.map((m) => ({
    role: m.role === "user" ? "user" : "model",
    parts: [{ text: m.content }],
  }));

interface SearchInput {
  query: string;
  docId: string;
  signal: AbortSignal;
}

// Returns null when the backend is unreachable or errors, so the caller can
// tell "search is down" apart from "search ran and found nothing".
const searchDocument = traceable(
  async ({ query, docId, signal }: SearchInput): Promise<RetrievedChunk[] | null> => {
  const backendUrl = process.env.RAG_BACKEND_URL;
  if (!backendUrl) {
    console.error("RAG_BACKEND_URL is not configured");
    return null;
  }
  try {
    const res = await fetch(`${backendUrl}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...traceHeaders() },
      body: JSON.stringify({ query, doc_ids: [docId], top_k: TOP_K }),
      signal,
    });
    if (!res.ok) {
      console.error("RAG search failed:", res.status, await res.text());
      return null;
    }
    const data = await res.json();
    return Array.isArray(data?.chunks) ? data.chunks : null;
  } catch (error) {
    if (signal.aborted) throw error;
    console.error("RAG search failed to reach backend:", error);
    return null;
  }
  },
  {
    name: "search_document",
    run_type: "retriever",
    ...traceConfig,
    processInputs: ({ query, docId }) => ({ query, docId, top_k: TOP_K }),
    // LangSmith renders retriever runs as a document list when shaped like this.
    processOutputs: ({ outputs }) => ({
      documents: (outputs ?? []).map((c) => ({
        type: "Document",
        page_content: c.text,
        metadata: { filename: c.filename, page: c.page, score: c.score, doc_id: c.doc_id },
      })),
      ...(outputs === null ? { error: "search unavailable" } : {}),
    }),
  }
);

interface ChatInput {
  ai: GoogleGenAI;
  model: string;
  messages: ChatMessage[];
  docId: unknown;
  generationConfig: GenerateContentConfig;
  signal: AbortSignal;
}

interface ChatResult {
  status: number;
  body: Record<string, unknown>;
}

// One LangSmith trace per chat request; search (including the Python backend's
// own runs) and each Gemini call nest under it.
const runChat = traceable(
  async ({ ai, model, messages, docId, generationConfig, signal }: ChatInput): Promise<ChatResult> => {
    // Returned so a thumbs up/down can be attached to this trace as feedback.
    const runId = currentRunId();

    const question = messages.at(-1)?.content ?? "";
    const history = recentHistory(messages.slice(0, -1));

    // No document attached — existing behaviour.
    if (docId === undefined || docId === null || docId === "") {
      const conversation: ChatMessage[] = [...history, { role: "user", content: question }];
      const response = await generateWithRetry(ai, model, toContents(conversation), {
        ...generationConfig,
        abortSignal: signal,
      });
      return {
        status: 200,
        body: { text: response.text || "No response generated", sources: [], runId },
      };
    }

    if (typeof docId !== "string" || !DOC_ID_PATTERN.test(docId)) {
      return { status: 400, body: { error: "Invalid document id" } };
    }

    // Searched verbatim: an earlier LLM rewrite step turned complete questions
    // into worse queries (e.g. dropped the headquarters page out of the top 10).
    const chunks = await searchDocument({ query: question, docId, signal });
    if (chunks === null) {
      return {
        status: 200,
        body: { text: "Document search is unavailable right now.", sources: [], runId },
      };
    }

    // Filtering by doc_id with no matches at all means the document is gone
    // from the index, not that it lacks the answer.
    if (chunks.length === 0) {
      return {
        status: 200,
        body: {
          text: "That document is no longer available. Please re-upload it.",
          sources: [],
          docMissing: true,
          runId,
        },
      };
    }

    const usable = chunks.filter((c) => c.score >= MIN_SCORE);
    if (usable.length === 0) {
      return { status: 200, body: { text: NO_ANSWER, sources: [], runId } };
    }

    const context = usable
      .map((c) => `[${c.filename}, page ${c.page}]\n${c.text}`)
      .join("\n\n---\n\n");

    // The user's settings still apply, but grounding needs the system prompt
    // and temperature 0 so the answer stays faithful to the retrieved text.
    const response = await generateWithRetry(
      ai,
      model,
      [
        ...toContents(history),
        { role: "user", parts: [{ text: `CONTEXT:\n${context}\n\nQUESTION: ${question}` }] },
      ],
      { ...generationConfig, systemInstruction: GROUNDED, temperature: 0, abortSignal: signal }
    );

    const text = response.text || "No response generated";
    // Citing pages under "I don't know" would imply they support an answer.
    const declined = /^["“]?I don['’]t know/.test(text.trim());

    return {
      status: 200,
      body: {
        text,
        sources: declined ? [] : usable.map((c) => ({ filename: c.filename, page: c.page })),
        runId,
      },
    };
  },
  {
    name: "chat",
    run_type: "chain",
    ...traceConfig,
    // Never log `ai` (carries the Gemini API key) or the abort signal.
    // LangSmith's trace list previews the first text field in alphabetical
    // order, which was `docId` for document questions. Keeping `input` as the
    // only top-level string (the rest nested under `settings`) makes the
    // question the preview.
    processInputs: ({ model, messages, docId, generationConfig }) => ({
      input: messages.at(-1)?.content ?? "",
      // The browser's message objects also carry UI-only fields (id, feedback…).
      messages: messages.map(({ role, content }) => ({ role, content })),
      settings: { docId, model, generationConfig },
    }),
    processOutputs: ({ status, body }) => {
      const { text, error, runId: _runId, ...rest } = body;
      return { output: text ?? error, status, ...rest };
    },
  }
);

export async function POST(request: NextRequest) {
  // Aborted when the browser cancels the fetch (the Stop button), so the
  // backend search and Gemini calls in flight are dropped instead of running
  // to completion for nobody.
  const signal = request.signal;
  flushTracesAfterResponse();
  try {
    const { messages, model, generationConfig, docId } = (await request.json()) as {
      messages: ChatMessage[];
      model?: unknown;
      generationConfig?: unknown;
      docId?: unknown;
    };

    const selectedModel =
      typeof model === "string" && ALLOWED_MODELS.has(model)
        ? model
        : DEFAULT_MODEL;

    const apiKey = process.env.GOOGLE_GENAI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "API key not configured" },
        { status: 500 }
      );
    }

    // Wrapped so every Gemini call (including failed retries) is recorded as an
    // LLM run with its prompt, output and token usage.
    const ai = wrapGemini(new GoogleGenAI({ apiKey }), traceConfig);

    const { status, body } = await runChat({
      ai,
      model: selectedModel,
      messages,
      docId,
      generationConfig: sanitizeGenerationConfig(generationConfig),
      signal,
    });
    return NextResponse.json(body, { status });
  } catch (error) {
    // The client is gone; there's no one to send an error to.
    if (signal.aborted) return new Response(null, { status: 499 });
    console.error("Chat API error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to generate response";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
