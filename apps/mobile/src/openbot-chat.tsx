import {
  CopilotKitProvider,
  type Message,
  useAgent,
  useCopilotKit,
} from "@copilotkit/react-native/headless";
import { ArrowUp, Square } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { API_URL } from "./api";
import { AssistantResponse } from "./assistant-response";
import { runConversationTurn } from "./conversation-run";
import { Button, colors, ErrorNotice, s } from "./ui";
import { type OpenBotChannel, useWorkspace } from "./workspace";

const pendingMessages = new Map<string, string>();
const uncertainRuns = new Set<string>();

export function OpenBotChat({ channel }: { channel: OpenBotChannel }) {
  const { api } = useWorkspace();
  return (
    <CopilotKitProvider
      runtimeUrl={`${API_URL}/api/openbot/copilotkit`}
      headers={{ Authorization: `Bearer ${api.token}` }}
    >
      <ChannelChat key={channel.id} channel={channel} />
    </CopilotKitProvider>
  );
}

function ChannelChat({ channel }: { channel: OpenBotChannel }) {
  const { api } = useWorkspace();
  const runtimeAgentId = channel.agentIds[0];
  const agentId = `openbot-${channel.id}`;
  const { agent, isReady } = useAgent({ agentId, runtimeAgentId, threadId: channel.threadId });
  const { copilotkit } = useCopilotKit();
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(() => pendingMessages.get(channel.threadId) ?? "");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [sendBlocked, setSendBlocked] = useState(() => uncertainRuns.has(channel.threadId));
  const [error, setError] = useState("");
  const list = useRef<ScrollView>(null);
  const runConfirmedDone = useRef(false);

  useEffect(() => {
    if (!isReady) return;
    let active = true;
    setLoading(true);
    void (async () => {
      try {
        await runConversationTurn(
          agentId,
          () => copilotkit.connectAgent({ agent }),
          (onError) => copilotkit.subscribe({ onError }),
        );
      } catch {
        if (active) setError("OpenBot could not reconnect. Loading saved messages…");
      }
      try {
        const stored = await api.request<{ messages: Message[] }>(
          `/api/openbot/copilotkit/threads/${encodeURIComponent(channel.threadId)}/messages?agentId=${encodeURIComponent(runtimeAgentId)}`,
        );
        if (active && Array.isArray(stored.messages)) {
          const ids = new Set(stored.messages.map((message) => message.id));
          agent.setMessages([
            ...stored.messages,
            ...agent.messages.filter((message) => !ids.has(message.id)),
          ]);
          setError("");
        }
      } catch {
        if (active) setError("OpenBot could not load saved messages. Reopen to try again.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
      void agent.detachActiveRun().catch(() => {});
    };
  }, [agent, agentId, api, channel.threadId, copilotkit, isReady, runtimeAgentId]);

  async function send() {
    const text = draft.trim();
    if (!text || !isReady || loading || busy || sendBlocked || agent.isRunning) return;
    runConfirmedDone.current = false;
    setBusy(true);
    setError("");
    agent.addMessage({
      id: `openbot-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: "user",
      content: text,
    });
    pendingMessages.set(channel.threadId, text);
    setPending(text);
    setDraft("");
    try {
      await runConversationTurn(
        agentId,
        () => copilotkit.runAgent({ agent }),
        (onError) => copilotkit.subscribe({ onError }),
      );
      runConfirmedDone.current = true;
      pendingMessages.delete(channel.threadId);
      uncertainRuns.delete(channel.threadId);
      setPending("");
      setSendBlocked(false);
      setError("");
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      setError(`${detail} The message is saved below. Check OpenBot before starting another run.`);
      uncertainRuns.add(channel.threadId);
      setSendBlocked(true);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (stopping || runConfirmedDone.current) return;
    uncertainRuns.add(channel.threadId);
    setSendBlocked(true);
    setStopping(true);
    setError("Stop requested. Waiting for OpenBot to finish this run.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(
        `${API_URL}/api/openbot/copilotkit/agent/${encodeURIComponent(runtimeAgentId)}/stop/${encodeURIComponent(channel.threadId)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${api.token}`,
            "Content-Type": "application/json",
          },
          signal: controller.signal,
        },
      );
      if (!response.ok) throw new Error(`OpenBot returned ${response.status}`);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      if (!runConfirmedDone.current)
        setError(
          `Could not confirm that OpenBot stopped: ${detail}. Check OpenBot before starting another run.`,
        );
    } finally {
      clearTimeout(timeout);
      setStopping(false);
    }
  }

  const messages = agent.messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Text style={[s.heading, { textAlign: "center", marginBottom: 8 }]}>
        {channel.name || "OpenBot conversation"}
      </Text>
      {loading && <ActivityIndicator color={colors.blueDark} />}
      <ErrorNotice
        error={
          error ||
          (sendBlocked
            ? "This conversation may still be running in OpenBot. Check it before starting another run."
            : "")
        }
      />
      <ScrollView
        ref={list}
        style={{ flex: 1 }}
        contentContainerStyle={{ gap: 12, paddingVertical: 14, flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
      >
        {!messages.length && !loading && (
          <Text style={[s.muted, { textAlign: "center", marginTop: 40 }]}>
            Start a conversation with this OpenBot Bot.
          </Text>
        )}
        {messages.map((message) => {
          const user = message.role === "user";
          const content = typeof message.content === "string" ? message.content : "";
          return (
            <View
              key={message.id}
              style={{
                alignSelf: user ? "flex-end" : "flex-start",
                maxWidth: "95%",
                padding: 14,
                borderRadius: 20,
                backgroundColor: user ? colors.blue : colors.card,
              }}
            >
              {user ? (
                <Text selectable style={s.text}>
                  {content}
                </Text>
              ) : (
                <AssistantResponse content={content} />
              )}
            </View>
          );
        })}
      </ScrollView>
      {sendBlocked && !!pending && (
        <Text selectable style={s.text}>
          Unconfirmed message: {pending}
        </Text>
      )}
      <View style={[s.row, { gap: 9, alignItems: "flex-end", paddingBottom: 8 }]}>
        <TextInput
          accessibilityLabel="Message OpenBot"
          value={draft}
          onChangeText={setDraft}
          editable={!loading}
          multiline
          placeholder="Message OpenBot"
          placeholderTextColor={colors.muted}
          style={[s.input, { flex: 1, maxHeight: 150 }]}
        />
        {agent.isRunning || busy ? (
          <Button small icon={Square} busy={stopping} onPress={() => void stop()}>
            Stop
          </Button>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send message to OpenBot"
            disabled={!draft.trim() || !isReady || loading || sendBlocked}
            onPress={() => void send()}
            style={{ padding: 12, borderRadius: 18, backgroundColor: colors.blueDark }}
          >
            <ArrowUp size={21} color={colors.text} />
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
