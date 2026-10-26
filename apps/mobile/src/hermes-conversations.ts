import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ConversationApi,
  type ConversationThread,
  loadConversationPage,
  updateConversation,
} from "./conversations";

export function useHermesConversations(api: ConversationApi, enabled: boolean) {
  const [threads, setThreads] = useState<ConversationThread[]>([]);
  const [isLoading, setLoading] = useState(enabled);
  const [isFetchingMoreThreads, setFetchingMore] = useState(false);
  const [isMutating, setMutating] = useState(false);
  const [error, setError] = useState<Error>();
  const [fetchMoreError, setFetchMoreError] = useState<Error>();
  const [hasMoreThreads, setHasMore] = useState(false);
  const offset = useRef(0);
  const generation = useRef(0);
  const fetching = useRef(false);
  const mutating = useRef(false);
  const load = useCallback(
    async (more: boolean) => {
      if (!enabled || fetching.current) return;
      fetching.current = true;
      const version = generation.current;
      if (more) {
        setFetchingMore(true);
        setFetchMoreError(undefined);
      } else {
        setLoading(true);
        setError(undefined);
      }
      try {
        const page = await loadConversationPage(api, more ? offset.current : 0);
        if (version !== generation.current) return;
        setThreads((previous) => {
          const items = new Map((more ? previous : []).map((item) => [item.id, item]));
          for (const item of page.threads) items.set(item.id, item);
          return [...items.values()];
        });
        offset.current = page.offset;
        setHasMore(page.hasMore);
      } catch (e) {
        if (version === generation.current)
          (more ? setFetchMoreError : setError)(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (version === generation.current) {
          fetching.current = false;
          setLoading(false);
          setFetchingMore(false);
        }
      }
    },
    [api, enabled],
  );
  useEffect(() => {
    void load(false);
    return () => {
      generation.current += 1;
      fetching.current = false;
    };
  }, [load]);
  async function mutate(id: string, patch: { title?: string; archived?: boolean }) {
    if (mutating.current) throw new Error("A conversation update is already in progress.");
    mutating.current = true;
    setMutating(true);
    try {
      const saved = await updateConversation(api, id, patch);
      setThreads((items) => items.map((item) => (item.id === id ? saved : item)));
    } finally {
      mutating.current = false;
      setMutating(false);
    }
  }
  return {
    threads,
    isLoading,
    isFetchingMoreThreads,
    isMutating,
    error,
    fetchMoreError,
    hasMoreThreads,
    refetchThreads: () => {
      void load(false);
    },
    fetchMoreThreads: () => {
      void load(true);
    },
    renameThread: (id: string, title: string) => mutate(id, { title }),
    archiveThread: (id: string) => mutate(id, { archived: true }),
    unarchiveThread: (id: string) => mutate(id, { archived: false }),
  };
}
