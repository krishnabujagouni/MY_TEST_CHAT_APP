import { traceable } from "langsmith/traceable";
import { flushTracesAfterResponse, traceConfig, traceHeaders } from "@/app/lib/tracing";

export const runtime = "nodejs";
export const maxDuration = 60;

// Mirrors MAX_UPLOAD_BYTES in the Python backend (RAG_HOMEWORK/api.py), so an
// oversized file is rejected here instead of being streamed to the backend first.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// FastAPI returns errors as {"detail": "..."}; anything else is passed through.
function readableError(body: string): string {
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed?.detail === "string") return parsed.detail;
  } catch {}
  return body || "Upload failed";
}

interface UploadResult {
  status: number;
  body: Record<string, unknown>;
}

// One trace per upload; the Python backend's parsing, embedding and Pinecone
// upsert runs nest under it via the forwarded trace headers.
const uploadDocument = traceable(
  async ({ backendUrl, form }: { backendUrl: string; form: FormData }): Promise<UploadResult> => {
    let res: Response;
    try {
      res = await fetch(`${backendUrl}/upload`, {
        method: "POST",
        body: form,
        headers: traceHeaders(),
      });
    } catch (error) {
      console.error("RAG upload failed to reach backend:", error);
      return {
        status: 503,
        body: { error: "Document service is unavailable. Is the RAG backend running?" },
      };
    }

    const body = await res.text();
    if (!res.ok) return { status: res.status, body: { error: readableError(body) } };

    try {
      return { status: 200, body: JSON.parse(body) }; // { doc_id, filename, pages, status }
    } catch {
      return { status: 502, body: { error: "Unexpected response from document service" } };
    }
  },
  {
    name: "upload_document",
    run_type: "chain",
    ...traceConfig,
    // Log the file's name and size, never its bytes.
    processInputs: ({ form }) => {
      const file = form.get("file") as File;
      return { filename: file.name, size_bytes: file.size };
    },
    processOutputs: ({ status, body }) => ({ status, ...body }),
  }
);

export async function POST(req: Request) {
  flushTracesAfterResponse();
  const backendUrl = process.env.RAG_BACKEND_URL;
  if (!backendUrl) {
    return Response.json({ error: "RAG_BACKEND_URL is not configured" }, { status: 500 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return Response.json({ error: "No file provided" }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "File too large (max 25 MB)." }, { status: 413 });
  }

  const { status, body } = await uploadDocument({ backendUrl, form });
  return Response.json(body, { status });
}
