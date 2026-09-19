import { NextRequest, NextResponse, after } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { langsmith, tracingEnabled } from "@/app/lib/tracing";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// LangSmith is deprecating run feedback without the project (session) id, so
// it's looked up once per server process and reused.
let projectIdPromise: Promise<string> | null = null;
function tracingProjectId(): Promise<string> {
  projectIdPromise ??= langsmith
    .readProject({ projectName: process.env.LANGSMITH_PROJECT || "default" })
    .then((project) => project.id)
    .catch((error) => {
      projectIdPromise = null; // e.g. the project doesn't exist yet; retry next time
      throw error;
    });
  return projectIdPromise;
}

// The run's own id doubles as the feedback id, so re-rating a reply updates
// its single "user_rating" in LangSmith instead of stacking up new ones —
// the same one-rating-per-reply rule the CSV follows.
async function recordRunFeedback(runId: string, feedback: "up" | "down") {
  const score = feedback === "up" ? 1 : 0;
  try {
    await langsmith.createFeedback({
      runId,
      sessionId: await tracingProjectId(),
      key: "user_rating",
      score,
      feedbackId: runId,
      feedbackSourceType: "app",
    });
  } catch {
    try {
      await langsmith.updateFeedback(runId, { score });
    } catch (error) {
      console.error("LangSmith feedback failed:", error);
    }
  }
}

export const runtime = "nodejs";

// Kept outside the repo tree conceptually (see .gitignore) since this is
// runtime-collected user data, not source.
const CSV_PATH = path.join(process.cwd(), "feedback.csv");
const COLUMNS = ["prompt", "response", "feedback"] as const;

interface FeedbackRow {
  prompt: string;
  response: string;
  feedback: string;
}

// Quote every field and double up embedded quotes so commas/newlines/quotes
// in a prompt or response can never corrupt the row structure (RFC 4180).
function toCsvField(value: string): string {
  return `"${value.replace(/\r\n/g, "\n").replace(/"/g, '""')}"`;
}

function toCsvLine(row: FeedbackRow): string {
  return COLUMNS.map((col) => toCsvField(row[col])).join(",") + "\n";
}

// Minimal RFC 4180 parser: handles quoted fields containing commas,
// doubled-up quotes, and embedded newlines — needed because prompts/
// responses can contain any of those.
function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;

  while (i < content.length) {
    const char = content[i];

    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += char;
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (char === "\n" || char === "\r") {
      row.push(field);
      rows.push(row);
      field = "";
      row = [];
      if (char === "\r" && content[i + 1] === "\n") i++;
      i++;
      continue;
    }
    field += char;
    i++;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

async function readRows(): Promise<FeedbackRow[]> {
  let content: string;
  try {
    content = await fs.readFile(CSV_PATH, "utf-8");
  } catch {
    return [];
  }
  const parsed = parseCsv(content);
  const dataRows = parsed.slice(1); // skip header
  return dataRows
    .filter((r) => r.length >= 3)
    .map((r) => ({ prompt: r[0], response: r[1], feedback: r[2] }));
}

async function writeRows(rows: FeedbackRow[]): Promise<void> {
  const header = COLUMNS.join(",") + "\n";
  await fs.writeFile(CSV_PATH, header + rows.map(toCsvLine).join(""), "utf-8");
}

export async function POST(request: NextRequest) {
  try {
    const { prompt, response, feedback, runId } = await request.json();

    if (
      typeof prompt !== "string" ||
      typeof response !== "string" ||
      (feedback !== "up" && feedback !== "down")
    ) {
      return NextResponse.json(
        { error: "Expected { prompt: string, response: string, feedback: 'up' | 'down' }" },
        { status: 400 }
      );
    }

    // One row per (prompt, response) pair: update it in place if this exact
    // exchange was already rated, otherwise append a new row.
    const rows = await readRows();
    const existingIndex = rows.findIndex(
      (r) => r.prompt === prompt && r.response === response
    );

    if (existingIndex !== -1) {
      rows[existingIndex] = { prompt, response, feedback };
    } else {
      rows.push({ prompt, response, feedback });
    }

    await writeRows(rows);

    if (tracingEnabled && typeof runId === "string" && UUID_PATTERN.test(runId)) {
      after(() => recordRunFeedback(runId, feedback));
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Feedback API error:", error);
    const message = error instanceof Error ? error.message : "Failed to save feedback";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
