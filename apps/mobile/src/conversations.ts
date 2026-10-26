import type { Message } from "@copilotkit/react-native/headless";
import type { MuseApi } from "./api";

export async function loadConversationMessages(
  api: ConversationApi,
  mode: "local" | "hermes",
  id: string,
) {
  const { messages } = await api.request<{ messages: Message[] }>(
    mode === "hermes"
      ? `/api/conversations/${encodeURIComponent(id)}/messages`
      : "/api/conversation",
  );
  return messages;
}
export async function saveConversationMessages(
  api: ConversationApi,
  mode: ConversationMode,
  messages: Message[],
) {
  if (mode === "local") await api.request("/api/conversation", { messages }, "PUT");
}

export type ConversationMode = "local" | "hermes" | "cloud";
export type ConversationApi = Pick<MuseApi, "request">;
export function conversationMode(runtime: {
  provider: string;
  richThreads?: boolean;
}): ConversationMode {
  return String(runtime.provider) === "agui" ? "hermes" : runtime.richThreads ? "cloud" : "local";
}
export type ConversationThread = { id: string; name: string | null; archived: boolean };
export async function loadConversationPage(api: ConversationApi, offset: number) {
  const page = await api.request<{
    conversations: { id: string; title: string | null; archived: boolean }[];
    hasMore: boolean;
  }>(`/api/conversations?limit=20&offset=${offset}`);
  return {
    threads: page.conversations.map(({ id, title, archived }) => ({ id, name: title, archived })),
    offset: offset + page.conversations.length,
    hasMore: page.hasMore,
  };
}
export async function updateConversation(
  api: ConversationApi,
  id: string,
  patch: { title?: string; archived?: boolean },
): Promise<ConversationThread> {
  const saved = await api.request<{ id: string; title: string | null; archived: boolean }>(
    `/api/conversations/${encodeURIComponent(id)}`,
    patch,
    "PATCH",
  );
  return { id: saved.id, name: saved.title, archived: saved.archived };
}
export function createConversation(api: ConversationApi, id: string) {
  return api.request<{ id: string; existing: boolean }>("/api/conversations", { id }, "POST");
}
