"use client";

import { useState, useRef, useEffect } from "react";
import {
  Menu,
  Plus,
  MessageCircle,
  Settings,
  HelpCircle,
  Copy,
  Pencil,
  Check,
  X,
  ThumbsUp,
  ThumbsDown,
  RotateCw,
  ChevronDown,
  SlidersHorizontal,
  Paperclip,
  FileText,
  LoaderCircle,
  Square,
  ArrowUp,
} from "lucide-react";
import Markdown from "./Markdown";
import ModelSettings, {
  DEFAULT_GENERATION_SETTINGS,
  buildGenerationConfigPayload,
  type GenerationSettings,
} from "./ModelSettings";
import type { Message, Conversation, Source, AttachedDocument } from "./types";

interface GeminiModel {
  id: string;
  label: string;
  description: string;
}

// Keep this in sync with ALLOWED_MODELS in app/api/chat/route.ts.
// Every entry here was verified with a live generateContent call against
// this project's API key (not just checked against ai.models.list(), which
// can list IDs that are actually 404 / quota-blocked for a given key). The
// Pro-tier models (gemini-3.1-pro-preview, gemini-pro-latest) currently
// return a hard 429 "quota exceeded" on this key's free tier — that's an
// account/billing limit, not a code issue — so they're left out until
// billing is enabled on the Google Cloud project.
const MODELS: GeminiModel[] = [
  { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash", description: "Newest and most capable flash model" },
  { id: "gemini-3-flash-preview", label: "Gemini 3 Flash", description: "Fast and versatile" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", description: "Strong general-purpose flash model" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", description: "Balanced speed and quality, previous generation" },
  { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", description: "Fastest, most efficient" },
];
const DEFAULT_MODEL_ID = MODELS[1].id;

const createMessage = (
  role: Message["role"],
  content: string,
  sources: Source[] = [],
  runId?: string
): Message => ({
  id:
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  role,
  content,
  feedback: null,
  sources,
  runId,
});

// The same page is often retrieved more than once; list it once.
const uniqueSources = (sources: Source[]) =>
  sources.filter(
    (s, i) => sources.findIndex((o) => o.filename === s.filename && o.page === s.page) === i
  );

export default function Chat() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [currentConvId, setCurrentConvId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [model, setModel] = useState(DEFAULT_MODEL_ID);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [generationSettings, setGenerationSettings] = useState<GenerationSettings>(
    DEFAULT_GENERATION_SETTINGS
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [attachedDoc, setAttachedDoc] = useState<AttachedDocument | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const currentConv = conversations.find((c) => c.id === currentConvId);
  const messages = currentConv?.messages || [];
  const currentModel = MODELS.find((m) => m.id === model) ?? MODELS[0];

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [modelMenuOpen]);

  const startNewChat = () => {
    const newId = Date.now().toString();
    setConversations((prev) => [...prev, { id: newId, title: "New chat", messages: [] }]);
    setCurrentConvId(newId);
  };

  const stopGenerating = () => abortControllerRef.current?.abort();

  // Sends `history` (the full message list to send as context) to the API
  // and returns the assistant's reply as a Message, or null if the user
  // stopped it. Never throws.
  const fetchAssistantReply = async (history: Message[]): Promise<Message | null> => {
    const controller = new AbortController();
    abortControllerRef.current = controller;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history,
          model,
          generationConfig: buildGenerationConfigPayload(generationSettings),
          docId: attachedDoc?.docId,
        }),
        signal: controller.signal,
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || "Failed to fetch response");
      }
      if (data.docMissing) setAttachedDoc(null);
      return createMessage("assistant", data.text, data.sources ?? [], data.runId);
    } catch (error) {
      if (controller.signal.aborted) return null;
      console.error("Error:", error);
      const detail = error instanceof Error ? error.message : String(error);
      return createMessage(
        "assistant",
        `Sorry, I encountered an error: ${detail}`
      );
    } finally {
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
    }
  };

  const handleUpload = async (file: File) => {
    setUploading(true);
    setUploadError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/rag/upload", { method: "POST", body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Upload failed");
      setAttachedDoc({ docId: data.doc_id, filename: data.filename, pages: data.pages });
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
      // Clear so picking the same file again still fires onChange.
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;

    let convId = currentConvId;
    if (!convId) {
      convId = Date.now().toString();
      setConversations((prev) => [
        ...prev,
        { id: convId!, title: "New chat", messages: [] },
      ]);
      setCurrentConvId(convId);
    }

    const priorMessages = messages;
    const userMessage = createMessage("user", input);
    const history = [...priorMessages, userMessage];

    setConversations((prev) =>
      prev.map((c) => (c.id === convId ? { ...c, messages: history } : c))
    );

    setInput("");
    setLoading(true);

    const assistantMessage = await fetchAssistantReply(history);

    if (assistantMessage) {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId
            ? { ...c, messages: [...history, assistantMessage] }
            : c
        )
      );
    }

    if (priorMessages.length === 0) {
      const title =
        userMessage.content.substring(0, 30) +
        (userMessage.content.length > 30 ? "..." : "");
      setConversations((prev) =>
        prev.map((c) => (c.id === convId ? { ...c, title } : c))
      );
    }

    setLoading(false);
  };

  const handleCopy = async (id: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedId(id);
      setTimeout(() => {
        setCopiedId((prev) => (prev === id ? null : prev));
      }, 1500);
    } catch (error) {
      console.error("Copy failed:", error);
    }
  };

  const handleFeedback = (messageId: string, type: "up" | "down") => {
    if (!currentConvId) return;
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;

    const message = messages[idx];
    const newFeedback = message.feedback === type ? null : type;

    setConversations((prev) =>
      prev.map((c) =>
        c.id === currentConvId
          ? {
              ...c,
              messages: c.messages.map((m) =>
                m.id === messageId ? { ...m, feedback: newFeedback } : m
              ),
            }
          : c
      )
    );

    // Only log when a rating is actually being given, not when un-toggling
    // one off. The prompt is the nearest preceding user message.
    if (!newFeedback) return;
    const promptMessage = messages
      .slice(0, idx)
      .reverse()
      .find((m) => m.role === "user");

    fetch("/api/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: promptMessage?.content ?? "",
        response: message.content,
        feedback: newFeedback,
        runId: message.runId,
      }),
    }).catch((error) => console.error("Failed to save feedback:", error));
  };

  const handleRegenerate = async (messageId: string) => {
    if (!currentConvId || loading) return;
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;

    const history = messages.slice(0, idx);
    setLoading(true);
    setConversations((prev) =>
      prev.map((c) => (c.id === currentConvId ? { ...c, messages: history } : c))
    );

    const assistantMessage = await fetchAssistantReply(history);

    if (assistantMessage) {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === currentConvId
            ? { ...c, messages: [...history, assistantMessage] }
            : c
        )
      );
    }
    setLoading(false);
  };

  const startEdit = (messageId: string, content: string) => {
    setEditingId(messageId);
    setEditText(content);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditText("");
  };

  const saveEdit = async (messageId: string) => {
    if (!currentConvId || !editText.trim() || loading) return;
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;

    const editedMessage: Message = { ...messages[idx], content: editText };
    const history = [...messages.slice(0, idx), editedMessage];

    setEditingId(null);
    setEditText("");
    setLoading(true);
    setConversations((prev) =>
      prev.map((c) => (c.id === currentConvId ? { ...c, messages: history } : c))
    );

    const assistantMessage = await fetchAssistantReply(history);

    if (assistantMessage) {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === currentConvId
            ? { ...c, messages: [...history, assistantMessage] }
            : c
        )
      );
    }
    setLoading(false);
  };

  const suggestedPrompts = [
    "Explain quantum computing",
    "Write a Python function",
    "Plan a trip to Japan",
    "Summarize a topic",
  ];

  return (
    <div className="flex h-screen bg-gradient-to-br from-blue-100 via-blue-50 to-white">
      {/* Sidebar */}
      <div
        className={`transition-all duration-300 flex flex-col bg-white border-r border-gray-200 ${
          sidebarOpen ? "w-64" : "w-0"
        } overflow-hidden`}
      >
        <div className="p-4 border-b border-gray-200">
          <button
            onClick={startNewChat}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-800 transition-colors font-medium"
          >
            <Plus size={18} />
            New chat
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="p-3 space-y-2">
            {conversations.map((conv) => (
              <button
                key={conv.id}
                onClick={() => setCurrentConvId(conv.id)}
                className={`w-full text-left px-3 py-2 rounded-lg transition-colors text-sm ${
                  currentConvId === conv.id
                    ? "bg-gray-200 text-gray-900 font-medium"
                    : "text-gray-600 hover:bg-gray-100"
                }`}
              >
                <div className="flex items-center gap-2">
                  <MessageCircle size={16} />
                  <span className="truncate">{conv.title}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="p-3 border-t border-gray-200 space-y-2">
          <button className="w-full text-left flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-100 text-gray-600 text-sm transition-colors">
            <HelpCircle size={18} />
            Help & FAQ
          </button>
          <button className="w-full text-left flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-gray-100 text-gray-600 text-sm transition-colors">
            <Settings size={18} />
            Settings
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <div className="border-b border-gray-200 bg-white bg-opacity-80 backdrop-blur-sm">
          <div className="max-w-4xl mx-auto px-4 py-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <Menu size={20} className="text-gray-700" />
              </button>
              <h1 className="text-2xl font-semibold text-gray-900">My Gemini App</h1>

              <div className="relative" ref={modelMenuRef}>
                <button
                  onClick={() => setModelMenuOpen((open) => !open)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-gray-200 bg-white hover:bg-gray-50 text-sm font-medium text-gray-700 transition-colors"
                >
                  {currentModel.label}
                  <ChevronDown
                    size={16}
                    className={`text-gray-500 transition-transform ${modelMenuOpen ? "rotate-180" : ""}`}
                  />
                </button>

                {modelMenuOpen && (
                  <div className="absolute left-0 top-full mt-2 w-72 bg-white border border-gray-200 rounded-xl shadow-lg py-1.5 z-10">
                    {MODELS.map((m) => (
                      <button
                        key={m.id}
                        onClick={() => {
                          setModel(m.id);
                          setModelMenuOpen(false);
                        }}
                        className={`w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-gray-50 transition-colors ${
                          m.id === model ? "bg-blue-50" : ""
                        }`}
                      >
                        <div className="flex-1">
                          <p className="text-sm font-medium text-gray-900">{m.label}</p>
                          <p className="text-xs text-gray-500">{m.description}</p>
                        </div>
                        {m.id === model && (
                          <Check size={16} className="text-blue-600 mt-0.5 flex-shrink-0" />
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button
                onClick={() => setSettingsOpen(true)}
                title="Model settings"
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <SlidersHorizontal size={18} className="text-gray-700" />
              </button>
            </div>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-4xl mx-auto w-full px-4 py-8">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center h-full min-h-[400px]">
                <h2 className="text-3xl font-semibold text-gray-900 mb-2">Hello there</h2>
                <p className="text-gray-600 mb-8">How can I help you today?</p>

                <div className="grid grid-cols-2 gap-3 w-full max-w-2xl">
                  {suggestedPrompts.map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => setInput(prompt)}
                      className="p-4 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-left transition-colors"
                    >
                      <p className="text-gray-900 text-sm font-medium">{prompt}</p>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg) => {
              const isEditing = editingId === msg.id;
              const isCopied = copiedId === msg.id;

              return (
                <div
                  key={msg.id}
                  className={`group flex gap-4 py-6 animate-in fade-in ${
                    msg.role === "user" ? "justify-end" : "justify-start"
                  }`}
                >
                  {msg.role === "assistant" && (
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white font-semibold text-lg">
                      🤖
                    </div>
                  )}
                  <div
                    className={`max-w-2xl flex flex-col ${
                      msg.role === "user" ? "items-end" : "items-start"
                    }`}
                  >
                    {isEditing ? (
                      <div className="w-full min-w-[280px]">
                        <textarea
                          value={editText}
                          onChange={(e) => setEditText(e.target.value)}
                          rows={3}
                          autoFocus
                          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-900 resize-none"
                        />
                        <div className="flex justify-end gap-2 mt-2">
                          <button
                            onClick={cancelEdit}
                            className="flex items-center gap-1 px-3 py-1.5 rounded-full text-sm text-gray-600 hover:bg-gray-100 transition-colors"
                          >
                            <X size={14} />
                            Cancel
                          </button>
                          <button
                            onClick={() => saveEdit(msg.id)}
                            disabled={!editText.trim() || loading}
                            className="flex items-center gap-1 px-3 py-1.5 rounded-full text-sm bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                          >
                            <Check size={14} />
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {msg.role === "user" ? (
                          <div className="bg-gray-100 rounded-2xl px-4 py-2.5">
                            <p className="text-gray-900 leading-relaxed whitespace-pre-wrap">
                              {msg.content}
                            </p>
                          </div>
                        ) : (
                          <div className="text-gray-900">
                            <Markdown content={msg.content} />
                            {msg.sources && msg.sources.length > 0 && (
                              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                                <span className="text-xs text-gray-500">Sources:</span>
                                {uniqueSources(msg.sources).map((s) => (
                                  <span
                                    key={`${s.filename}-${s.page}`}
                                    className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2 py-0.5 text-xs text-gray-700"
                                  >
                                    <FileText size={12} />
                                    {s.filename}, p. {s.page}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Action toolbar */}
                        <div className="flex items-center gap-1 mt-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                          <button
                            onClick={() => handleCopy(msg.id, msg.content)}
                            title="Copy"
                            className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 transition-colors"
                          >
                            {isCopied ? <Check size={15} /> : <Copy size={15} />}
                          </button>

                          {msg.role === "user" ? (
                            <button
                              onClick={() => startEdit(msg.id, msg.content)}
                              title="Edit"
                              disabled={loading}
                              className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 disabled:opacity-40 transition-colors"
                            >
                              <Pencil size={15} />
                            </button>
                          ) : (
                            <>
                              <button
                                onClick={() => handleRegenerate(msg.id)}
                                title="Regenerate response"
                                disabled={loading}
                                className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-800 disabled:opacity-40 transition-colors"
                              >
                                <RotateCw size={15} />
                              </button>
                              <button
                                onClick={() => handleFeedback(msg.id, "up")}
                                title="Good response"
                                className={`p-1.5 rounded-md hover:bg-gray-100 transition-colors ${
                                  msg.feedback === "up"
                                    ? "text-blue-600"
                                    : "text-gray-500 hover:text-gray-800"
                                }`}
                              >
                                <ThumbsUp
                                  size={15}
                                  fill={msg.feedback === "up" ? "currentColor" : "none"}
                                />
                              </button>
                              <button
                                onClick={() => handleFeedback(msg.id, "down")}
                                title="Bad response"
                                className={`p-1.5 rounded-md hover:bg-gray-100 transition-colors ${
                                  msg.feedback === "down"
                                    ? "text-blue-600"
                                    : "text-gray-500 hover:text-gray-800"
                                }`}
                              >
                                <ThumbsDown
                                  size={15}
                                  fill={msg.feedback === "down" ? "currentColor" : "none"}
                                />
                              </button>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                  {msg.role === "user" && (
                    <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-green-400 to-green-600 flex items-center justify-center text-white font-semibold text-lg">
                      👤
                    </div>
                  )}
                </div>
              );
            })}

            {loading && (
              <div className="flex gap-4 py-6 animate-in fade-in">
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white font-semibold text-lg">
                  🤖
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></div>
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0.1s" }}></div>
                  <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0.2s" }}></div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Input */}
        <div className="bg-white bg-opacity-80 backdrop-blur-sm border-t border-gray-200 py-4">
          <div className="max-w-4xl mx-auto px-4">
            {(attachedDoc || uploading || uploadError) && (
              <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
                {uploading && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 text-gray-600">
                    <LoaderCircle size={14} className="animate-spin" />
                    Uploading and indexing…
                  </span>
                )}
                {attachedDoc && !uploading && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-blue-50 px-3 py-1 text-blue-800">
                    <FileText size={14} />
                    {attachedDoc.filename}
                    <span className="text-blue-600/70">· {attachedDoc.pages} pages</span>
                    <button
                      type="button"
                      onClick={() => setAttachedDoc(null)}
                      title="Remove document"
                      className="ml-0.5 rounded-full p-0.5 hover:bg-blue-100"
                    >
                      <X size={12} />
                    </button>
                  </span>
                )}
                {uploadError && !uploading && (
                  <span className="text-red-600">{uploadError}</span>
                )}
              </div>
            )}
            <form onSubmit={handleSubmit} className="flex gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf,.pdf"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleUpload(file);
                }}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading || loading}
                title="Attach a PDF"
                className="p-3 rounded-full border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Paperclip size={20} />
              </button>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={attachedDoc ? `Ask about ${attachedDoc.filename}` : "Message Gemini"}
                disabled={loading}
                className="flex-1 px-4 py-3 border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder-gray-500 disabled:bg-gray-50 disabled:cursor-not-allowed transition-all bg-white text-gray-900"
              />
              {/* One button in one place: send (arrow) when idle, stop (square) while a reply generates. */}
              {loading ? (
                <button
                  type="button"
                  onClick={stopGenerating}
                  title="Stop generating"
                  aria-label="Stop generating"
                  className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-gray-900 text-white hover:bg-gray-700 transition-colors"
                >
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim()}
                  title="Send message"
                  aria-label="Send message"
                  className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                >
                  <ArrowUp size={20} strokeWidth={2.5} />
                </button>
              )}
            </form>
          </div>
        </div>
      </div>

      <ModelSettings
        open={settingsOpen}
        settings={generationSettings}
        onChange={setGenerationSettings}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
