export interface Source {
  filename: string;
  page: number;
}

export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  feedback?: "up" | "down" | null;
  sources?: Source[];
  // LangSmith trace id for this reply, used to attach thumbs up/down to it.
  runId?: string;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
}

export interface AttachedDocument {
  docId: string;
  filename: string;
  pages: number;
}
