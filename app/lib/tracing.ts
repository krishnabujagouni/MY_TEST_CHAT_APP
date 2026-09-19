import { after } from "next/server";
import { Client } from "langsmith";
import { getCurrentRunTree } from "langsmith/traceable";

// On only when explicitly enabled AND a key is present, so a missing key never
// turns into a failed trace upload on every request.
export const tracingEnabled =
  process.env.LANGSMITH_TRACING === "true" && Boolean(process.env.LANGSMITH_API_KEY);

export const langsmith = new Client();

// Spread into every traceable()/wrapGemini() so they share one client and
// respect the gate above rather than reading LANGSMITH_TRACING on their own.
export const traceConfig = { client: langsmith, tracingEnabled };

// Sent with calls to the Python backend so its runs nest under the current
// trace (it reads them with tracing_context(parent=request.headers)).
export function traceHeaders(): Record<string, string> {
  if (!tracingEnabled) return {};
  const run = getCurrentRunTree(true);
  return run ? run.toHeaders() : {};
}

export function currentRunId(): string | undefined {
  return tracingEnabled ? getCurrentRunTree(true)?.id : undefined;
}

// Runs upload in background batches; make sure they're sent after responding.
export function flushTracesAfterResponse() {
  if (tracingEnabled) after(() => langsmith.awaitPendingTraceBatches());
}
