import { GoogleGenAI } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// Keep this in sync with MODELS in app/components/Chat.tsx
const ALLOWED_MODELS = new Set([
  "gemini-3.6-flash",
  "gemini-3-flash-preview",
  "gemini-3.5-flash",
  "gemini-2.5-flash",
  "gemini-3.5-flash-lite",
]);
const DEFAULT_MODEL = "gemini-3-flash-preview";

export async function POST(request: NextRequest) {
  try {
    const { messages, model } = await request.json();

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

    const ai = new GoogleGenAI({ apiKey });

    // Convert chat messages to Gemini format
    const contents = messages.map(
      (msg: { role: string; content: string }) => ({
        role: msg.role === "user" ? "user" : "model",
        parts: [{ text: msg.content }],
      })
    );

    const response = await ai.models.generateContent({
      model: selectedModel,
      contents,
    });

    const text =
      response.candidates?.[0]?.content?.parts?.[0]?.text ||
      "No response generated";

    return NextResponse.json({ text });
  } catch (error) {
    console.error("Chat API error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to generate response";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
