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

interface SourceRef {
  filename: string;
  page: number;
}

// Streamed to the browser as newline-delimited JSON: `meta` once before the
// answer (and again if sources are withdrawn), then one `delta` per chunk.
type ChatEvent =
  | { type: "meta"; runId?: string; sources: SourceRef[]; docMissing?: boolean }
  | { type: "delta"; text: string }
  | { type: "error"; error: string };

type Emit = (event: ChatEvent) => Promise<void>;

// Streams Gemini's answer, emitting each chunk as it arrives, and returns the
// full text once it is done. Retrying is only safe before the first chunk is
// emitted — after that the browser already has a partial answer that a second
// attempt would duplicate.
async function streamAnswer(
  ai: GoogleGenAI,
  model: string,
  contents: Content[],
  config: GenerateContentConfig,
  emit: Emit
): Promise<string> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let streamed = false;
    try {
      const stream = await ai.models.generateContentStream({ model, contents, config });
      let text = "";
      for await (const chunk of stream) {
        const piece = chunk.text;
        if (!piece) continue;
        streamed = true;
        text += piece;
        await emit({ type: "delta", text: piece });
      }
      if (text) return text;
      const empty = "No response generated";
      await emit({ type: "delta", text: empty });
      return empty;
    } catch (error) {
      const isRetryable =
        !streamed &&
        error instanceof ApiError &&
        error.status === 503 &&
        !config.abortSignal?.aborted;
      if (!isRetryable || attempt === MAX_ATTEMPTS) throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1])
      );
    }
  }
  // Unreachable: the loop above always either returns or throws.
  throw new Error("streamAnswer: exhausted attempts without a result");
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
  docId: string | null | undefined;
  generationConfig: GenerateContentConfig;
  signal: AbortSignal;
  emit: Emit;
}

// What LangSmith records; the browser gets the same content as it is produced.
interface ChatResult {
  text: string;
  sources: SourceRef[];
  docMissing?: boolean;
}

// One LangSmith trace per chat request; search (including the Python backend's
// own runs) and each Gemini call nest under it. The answer is streamed to the
// browser through `emit` as it is generated, but this function only resolves
// once the stream is finished, so the trace records the whole answer and the
// true duration.
const runChat = traceable(
  async ({ ai, model, messages, docId, generationConfig, signal, emit }: ChatInput): Promise<ChatResult> => {
    // Sent to the browser so a thumbs up/down can be attached to this trace.
    const runId = currentRunId();

    const question = messages.at(-1)?.content ?? "";
    const history = recentHistory(messages.slice(0, -1));

    // Answers that don't come from the model (search down, document gone…)
    // are emitted in one piece so the client only handles one shape.
    const sendFixedAnswer = async (text: string, extra: Record<string, unknown> = {}) => {
      await emit({ type: "meta", runId, sources: [], ...extra });
      await emit({ type: "delta", text });
      return { text, sources: [], ...extra };
    };

    // No document attached — plain chat.
    if (docId === undefined || docId === null || docId === "") {
      const conversation: ChatMessage[] = [...history, { role: "user", content: question }];
      await emit({ type: "meta", runId, sources: [] });
      const text = await streamAnswer(ai, model, toContents(conversation), {
        ...generationConfig,
        abortSignal: signal,
      }, emit);
      return { text, sources: [] };
    }

    // Searched verbatim: an earlier LLM rewrite step turned complete questions
    // into worse queries (e.g. dropped the headquarters page out of the top 10).
    const chunks = await searchDocument({ query: question, docId, signal });
    if (chunks === null) {
      return sendFixedAnswer("Document search is unavailable right now.");
    }

    // Filtering by doc_id with no matches at all means the document is gone
    // from the index, not that it lacks the answer.
    if (chunks.length === 0) {
      return sendFixedAnswer("That document is no longer available. Please re-upload it.", {
        docMissing: true,
      });
    }

    const usable = chunks.filter((c) => c.score >= MIN_SCORE);
    if (usable.length === 0) return sendFixedAnswer(NO_ANSWER);

    const context = usable
      .map((c) => `[${c.filename}, page ${c.page}]\n${c.text}`)
      .join("\n\n---\n\n");

    const sources = usable.map((c) => ({ filename: c.filename, page: c.page }));
    await emit({ type: "meta", runId, sources });

    // The user's settings still apply, but grounding needs the system prompt
    // and temperature 0 so the answer stays faithful to the retrieved text.
    const text = await streamAnswer(
      ai,
      model,
      [
        ...toContents(history),
        { role: "user", parts: [{ text: `CONTEXT:\n${context}\n\nQUESTION: ${question}` }] },
      ],
      { ...generationConfig, systemInstruction: GROUNDED, temperature: 0, abortSignal: signal },
      emit
    );

    // Citing pages under "I don't know" would imply they support an answer, so
    // they are withdrawn (the client replaces the sources it got in `meta`).
    const declined = /^["“]?I don['’]t know/.test(text.trim());
    if (declined) await emit({ type: "meta", runId, sources: [] });

    return { text, sources: declined ? [] : sources };
  },
  {
    name: "chat",
    run_type: "chain",
    ...traceConfig,
    // Never log `ai` (carries the Gemini API key), the abort signal or `emit`.
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
    processOutputs: ({ text, ...rest }) => ({ output: text, ...rest }),
  }
);

export async function POST(request: NextRequest) {
  // Aborted when the browser cancels the fetch (the Stop button), so the
  // backend search and Gemini calls in flight are dropped instead of running
  // to completion for nobody.
  const signal = request.signal;
  flushTracesAfterResponse();

  // Everything that can fail before the answer starts is answered with plain
  // JSON and a status code; once the stream opens the status is already 200,
  // so later failures arrive as an `error` event instead.
  let payload: {
    messages?: unknown;
    model?: unknown;
    generationConfig?: unknown;
    docId?: unknown;
  };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { messages, model, generationConfig, docId } = payload;
  if (!Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: "No messages provided" }, { status: 400 });
  }

  const hasDoc = docId !== undefined && docId !== null && docId !== "";
  if (hasDoc && (typeof docId !== "string" || !DOC_ID_PATTERN.test(docId))) {
    return NextResponse.json({ error: "Invalid document id" }, { status: 400 });
  }

  const apiKey = process.env.GOOGLE_GENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "API key not configured" }, { status: 500 });
  }

  const selectedModel =
    typeof model === "string" && ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;

  // Wrapped so every Gemini call (including failed retries) is recorded as an
  // LLM run with its prompt, output and token usage.
  const ai = wrapGemini(new GoogleGenAI({ apiKey }), traceConfig);

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const emit: Emit = async (event) => {
    await writer.write(encoder.encode(`${JSON.stringify(event)}\n`));
  };

  // Deliberately not awaited: the response has to start flowing before the
  // answer exists. The stream stays open until this finishes.
  void (async () => {
    try {
      await runChat({
        ai,
        model: selectedModel,
        messages: messages as ChatMessage[],
        docId: hasDoc ? (docId as string) : null,
        generationConfig: sanitizeGenerationConfig(generationConfig),
        signal,
        emit,
      });
    } catch (error) {
      // An aborted request means the client is gone; a failed write means the
      // same. Either way there is no one left to report the error to.
      if (!signal.aborted) {
        console.error("Chat API error:", error);
        const message =
          error instanceof Error ? error.message : "Failed to generate response";
        await emit({ type: "error", error: message }).catch(() => {});
      }
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      // Keeps proxies from buffering the response into one delivery.
      "X-Accel-Buffering": "no",
    },
  });
}
