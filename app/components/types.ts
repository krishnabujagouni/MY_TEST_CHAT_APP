export interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  feedback?: "up" | "down" | null;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
}
