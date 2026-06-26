"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { Minus, Maximize2, Minimize2, ChevronDown, Plus, Check, Trash2, Pencil, Loader2, Square, X } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { cn } from "@multica/ui/lib/utils";
import { Tooltip, TooltipTrigger, TooltipContent } from "@multica/ui/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@multica/ui/components/ui/popover";
import { toast } from "sonner";
import { useWorkspaceId } from "@multica/core/hooks";
import { useAuthStore } from "@multica/core/auth";
import { isAgentChatPath, useWorkspacePaths } from "@multica/core/paths";
import { agentListOptions, memberListOptions } from "@multica/core/workspace/queries";
import { canAssignAgent } from "@multica/views/issues/components";
import { api } from "@multica/core/api";
import { useAgentPresenceDetail, useWorkspaceAgentAvailability, type AgentAvailability } from "@multica/core/agents";
import { useFileUpload, type UploadResult } from "@multica/core/hooks/use-file-upload";
import { ActorAvatar } from "../../common/actor-avatar";
import { Markdown } from "../../common/markdown";
import { AttachmentList } from "../../issues/components/comment-card";
import {
  PickerEmpty,
  PickerItem,
  PickerSection,
  PropertyPicker,
} from "../../issues/components/pickers/property-picker";
import { matchesPinyin } from "../../editor/extensions/pinyin-match";
import type { MentionItem } from "../../editor/extensions/mention-suggestion";
import { OfflineBanner } from "./offline-banner";
import { NoAgentBanner } from "./no-agent-banner";
import {
  chatSessionsOptions,
  chatMessagesPageOptions,
  pendingChatTaskOptions,
  pendingChatTasksOptions,
  taskMessagesOptions,
  chatKeys,
  isTaskMessageTaskId,
} from "@multica/core/chat/queries";
import {
  useCreateChatSession,
  useDeleteChatSession,
  useMarkChatSessionRead,
  useUpdateChatSession,
} from "@multica/core/chat/mutations";
import { useChatStore } from "@multica/core/chat";
import { AssistantMessage, ChatMessageList, ChatMessageSkeleton } from "./chat-message-list";
import { ChatInput } from "./chat-input";
import { ChatResizeHandles } from "./chat-resize-handles";
import { TaskStatusPill } from "./task-status-pill";
import { useChatContextItems } from "./use-chat-context-items";
import { useChatResize } from "./use-chat-resize";
import { createLogger } from "@multica/core/logger";
import type { Agent, Attachment, ChatMessage, ChatMessagesPage, ChatPendingTask, ChatSession, PendingChatTasksResponse, TaskMessagePayload, User } from "@multica/core/types";
import { useT } from "../../i18n";
import { AppLink, useNavigation } from "../../navigation";

const uiLogger = createLogger("chat.ui");
const apiLogger = createLogger("chat.api");
const CHAT_VIRTUOSO_INITIAL_FIRST_ITEM_INDEX = 1_000_000;
const THREAD_PANEL_DEFAULT_WIDTH = 560;
const THREAD_PANEL_MIN_WIDTH = 380;
const THREAD_PANEL_MAX_WIDTH = 760;
const THREAD_MAIN_MIN_WIDTH = 360;

function appendChatMessageToLatestPageCache(
  qc: ReturnType<typeof useQueryClient>,
  sessionId: string,
  message: ChatMessage,
) {
  qc.setQueryData<InfiniteData<ChatMessagesPage>>(
    chatKeys.messagesPage(sessionId),
    (old) => {
      if (!old) {
        return {
          pages: [{
            messages: [message],
            limit: 50,
            has_more: false,
            next_cursor: null,
          }],
          pageParams: [null],
        };
      }
      if (old.pages.some((page) => page.messages.some((m) => m.id === message.id))) {
        return old;
      }
      return {
        ...old,
        pages: old.pages.map((page, index) =>
          index === 0 ? { ...page, messages: [...page.messages, message] } : page,
        ),
      };
    },
  );
}

function removeChatMessageFromPageCache(
  qc: ReturnType<typeof useQueryClient>,
  sessionId: string,
  messageId: string,
) {
  qc.setQueryData<InfiniteData<ChatMessagesPage> | undefined>(
    chatKeys.messagesPage(sessionId),
    (old) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          messages: page.messages.filter((m) => m.id !== messageId),
        })),
      };
    },
  );
}

function removeChatMessageFromCaches(
  qc: ReturnType<typeof useQueryClient>,
  sessionId: string,
  messageId: string,
) {
  qc.setQueryData<ChatMessage[]>(
    chatKeys.messages(sessionId),
    (old) => old?.filter((m) => m.id !== messageId) ?? old,
  );
  removeChatMessageFromPageCache(qc, sessionId, messageId);
}

function replaceOptimisticChatMessageId(
  qc: ReturnType<typeof useQueryClient>,
  sessionId: string,
  optimisticId: string,
  messageId: string,
  taskId: string,
  threadTaskId: string,
  chatThreadId?: string | null,
) {
  const replace = (messages: ChatMessage[] | undefined) => {
    if (!messages) return messages;
    if (messages.some((m) => m.id === messageId)) {
      return messages.filter((m) => m.id !== optimisticId);
    }
    return messages.map((m) =>
      m.id === optimisticId
        ? { ...m, id: messageId, task_id: taskId, thread_task_id: threadTaskId, chat_thread_id: chatThreadId ?? m.chat_thread_id ?? null }
        : m,
    );
  };

  qc.setQueryData<ChatMessage[]>(
    chatKeys.messages(sessionId),
    replace,
  );
  qc.setQueryData<InfiniteData<ChatMessagesPage> | undefined>(
    chatKeys.messagesPage(sessionId),
    (old) => {
      if (!old) return old;
      return {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          messages: replace(page.messages) ?? page.messages,
        })),
      };
    },
  );
}

type ChatSurfaceMode = "floating" | "page";

interface SendChatMessageOptions {
  replyToThreadTaskId?: string;
  chatThreadId?: string;
  clientThreadKey?: string;
  draftKeyScope?: string;
}

interface ChatSurfaceProps {
  mode: ChatSurfaceMode;
  routeAgentId?: string;
}

export function ChatWindow() {
  return <ChatSurface mode="floating" />;
}

export function AgentChatPage({ agentId }: { agentId: string }) {
  return <ChatSurface mode="page" routeAgentId={agentId} />;
}

function ChatSurface({ mode, routeAgentId }: ChatSurfaceProps) {
  const pageMode = mode === "page";
  const { t } = useT("chat");
  const wsId = useWorkspaceId();
  const workspacePaths = useWorkspacePaths();
  const { pathname } = useNavigation();
  const isOpen = useChatStore((s) => s.isOpen);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const selectedAgentId = useChatStore((s) => s.selectedAgentId);
  const setOpen = useChatStore((s) => s.setOpen);
  const setActiveSession = useChatStore((s) => s.setActiveSession);
  const setSelectedAgentId = useChatStore((s) => s.setSelectedAgentId);
  const user = useAuthStore((s) => s.user);
  const { data: agents = [], isPending: agentsPending } = useQuery(agentListOptions(wsId));
  const { data: members = [], isPending: membersPending } = useQuery(memberListOptions(wsId));
  // Single sessions cache — eliminates the separate active/all queries
  // that used to drift during the WS-invalidate window.
  const { data: sessions = [], isPending: sessionsPending } = useQuery(chatSessionsOptions(wsId));
  const storedActiveSession = activeSessionId
    ? sessions.find((s) => s.id === activeSessionId)
    : null;
  const effectiveActiveSessionId =
    pageMode &&
    (!storedActiveSession ||
      storedActiveSession.agent_id !== routeAgentId ||
      storedActiveSession.status === "archived")
      ? null
      : activeSessionId;
  const {
    data: rawMessagePages,
    isLoading: messagesLoading,
    fetchNextPage: fetchOlderMessages,
    hasNextPage: hasOlderMessages,
    isFetchingNextPage: isFetchingOlderMessages,
  } = useInfiniteQuery(chatMessagesPageOptions(effectiveActiveSessionId ?? ""));
  // When no active session, always show empty — don't use stale cache.
  // Page 0 contains the latest chronological window; later cursor pages are
  // older chronological windows. Reverse pages so older fetched pages render
  // above the initial latest page. The Virtuoso firstItemIndex is client-owned:
  // it starts from a large stable base and only subtracts the count of loaded
  // prepended rows, so concurrent server inserts cannot drift the scroll anchor.
  const messagePages = effectiveActiveSessionId ? rawMessagePages?.pages ?? [] : [];
  const messages = [...messagePages].reverse().flatMap((page) => page.messages);
  const olderMessageCount = messagePages.slice(1).reduce((sum, page) => sum + page.messages.length, 0);
  const firstItemIndex = messages.length > 0
    ? CHAT_VIRTUOSO_INITIAL_FIRST_ITEM_INDEX - olderMessageCount
    : 0;
  // Skeleton only shows for an un-cached session fetch. Cached switches
  // return data synchronously — no flash. `enabled: false` (new chat)
  // keeps isLoading false so the starter prompts aren't hidden.
  const showSkeleton = !!effectiveActiveSessionId && messagesLoading;

  // Server-authoritative pending task. Survives refresh / reopen / session
  // switch because it's keyed on sessionId in the Query cache; WS events
  // (chat:message / chat:done / task:*) keep it invalidated in real time.
  //
  // This is the SOLE source for pendingTaskId — no mirror in the store.
  const { data: pendingTask } = useQuery(
    pendingChatTaskOptions(effectiveActiveSessionId ?? ""),
  );
  const pendingTaskId = pendingTask?.task_id ?? null;
  const stopRequestedBeforeTaskRef = useRef(false);
  const [restoreDraftRequest, setRestoreDraftRequest] = useState<{
    id: string;
    content: string;
    attachments?: Attachment[];
    sessionId?: string;
    draftKeyScope?: string;
  } | null>(null);
  const handleRestoreDraftConsumed = useCallback(() => {
    setRestoreDraftRequest(null);
  }, []);

  // Legacy archived sessions (the old soft-archive feature was removed but
  // pre-existing rows with status='archived' may still exist) are excluded
  // from the history dropdown. If one is still the active session, ChatInput
  // is disabled and the server still rejects POST /messages for it.
  const currentSession = effectiveActiveSessionId
    ? sessions.find((s) => s.id === effectiveActiveSessionId)
    : null;
  const isSessionArchived = currentSession?.status === "archived";

  const qc = useQueryClient();
  const createSession = useCreateChatSession();
  const markRead = useMarkChatSessionRead();

  const currentMember = members.find((m) => m.user_id === user?.id);
  const memberRole = currentMember?.role;
  const availableAgents = agents.filter(
    (a) => !a.archived_at && canAssignAgent(a, user?.id, memberRole),
  );

  // Resolve selected agent: stored preference → first available
  const routeAgent = routeAgentId
    ? agents.find((a) => a.id === routeAgentId) ?? null
    : null;
  const routedAvailableAgent = routeAgentId
    ? availableAgents.find((a) => a.id === routeAgentId) ?? null
    : null;
  const activeAgent = pageMode
    ? routedAvailableAgent
    : availableAgents.find((a) => a.id === selectedAgentId) ??
      availableAgents[0] ??
      null;
  const displayAgent = routeAgent ?? activeAgent;

  // Three-state availability — "loading" stays neutral (no banner, no
  // disable) so the input doesn't flash a fake "no agent" state in the
  // few hundred ms before the agent list query resolves. Only `"none"`
  // (server confirmed: zero usable agents) drives the disabled UI.
  const agentAvailability = useWorkspaceAgentAvailability();
  const noAgent = pageMode ? !agentsPending && !membersPending && !activeAgent : agentAvailability === "none";

  useEffect(() => {
    if (!pageMode || !routeAgentId) return;

    // The route owns the page chat target. Keep the legacy floating panel
    // closed here so this page is the only visible chat surface.
    if (isOpen) setOpen(false);
    if (selectedAgentId !== routeAgentId) setSelectedAgentId(routeAgentId);
    if (sessionsPending) return;

    const activeSession = activeSessionId
      ? sessions.find((s) => s.id === activeSessionId)
      : null;
    if (activeSession?.agent_id === routeAgentId && activeSession.status !== "archived") {
      return;
    }

    const latestSession = sessions
      .filter((s) => s.agent_id === routeAgentId && s.status !== "archived")
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0] ?? null;
    const nextSessionId = latestSession?.id ?? null;
    if (nextSessionId !== activeSessionId) {
      setActiveSession(nextSessionId);
    }
  }, [
    activeSessionId,
    isOpen,
    pageMode,
    routeAgentId,
    selectedAgentId,
    sessions,
    sessionsPending,
    setActiveSession,
    setOpen,
    setSelectedAgentId,
  ]);

  // Presence drives both the avatar status dot (via ActorAvatar) and the
  // OfflineBanner / TaskStatusPill availability copy. `useAgentPresenceDetail`
  // returns "loading" while queries are still resolving — pass `undefined`
  // downstream so banners and pill copy stay silent during loading rather
  // than flash speculative offline text.
  // Key presence on the DISPLAYED agent, not the assignable one: in page mode
  // an agent the viewer can't assign (e.g. someone else's private agent) still
  // resolves as `routeAgent`, so its real online/offline state surfaces in the
  // header dot and OfflineBanner instead of falling back to neutral.
  const presenceDetail = useAgentPresenceDetail(wsId, displayAgent?.id);
  const availability =
    presenceDetail === "loading" ? undefined : presenceDetail.availability;

  // Mount / unmount logging. ChatWindow lives in DashboardLayout, so this
  // fires on layout mount (login / workspace switch / fresh page load).
  useEffect(() => {
    uiLogger.info("ChatWindow mount", {
      isOpen,
      activeSessionId,
      pendingTaskId,
      selectedAgentId,
      wsId,
    });
    return () => {
      uiLogger.info("ChatWindow unmount", {
        activeSessionId,
        pendingTaskId,
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per mount
  }, []);

  // Open intent is fully driven by `activeSessionId` in storage — no mount
  // restore, no self-heal. Adding either reintroduces a "two signals
  // describing one fact" race (the previous self-heal mis-cleared the
  // freshly-created session because allSessions was still stale during the
  // post-create invalidate-refetch window).

  // WS events are handled globally in useRealtimeSync — the query cache
  // stays current even when this window is closed. See packages/core/realtime/.

  // Auto mark-as-read whenever the user is looking at a session with unread
  // state: window open + a session active + has_unread → PATCH.
  // has_unread comes from the list query; WS handlers invalidate it on
  // chat:done so a reply arriving while the user watches triggers this
  // effect again and is instantly cleared.
  const currentHasUnread =
    sessions.find((s) => s.id === effectiveActiveSessionId)?.has_unread ?? false;
  useEffect(() => {
    if ((!isOpen && !pageMode) || !effectiveActiveSessionId) return;
    if (!currentHasUnread) return;
    uiLogger.info("auto markRead", { sessionId: effectiveActiveSessionId });
    markRead.mutate(effectiveActiveSessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- markRead ref stable
  }, [isOpen, pageMode, effectiveActiveSessionId, currentHasUnread]);

  const { uploadWithToast } = useFileUpload(api);

  // Lazy-creates a chat_session the first time the user needs an id —
  // either to send a message or to attach an uploaded file. Pulled out of
  // handleSend so the upload path (which fires before any text exists) can
  // get a session_id to hang the attachment on. Returns null when no agent
  // is available; callers must early-return in that case.
  //
  // Concurrent callers (e.g. user drops a file → handleUploadFile, then
  // quickly clicks send → handleSend) would each observe activeSessionId
  // === null and fire a separate createSession.mutateAsync, creating two
  // sessions and orphaning the attachment on the wrong one. The in-flight
  // promise ref dedupes those races: the first caller starts the create,
  // every subsequent caller awaits the same promise until it settles.
  //
  // titleSeed is the first 50 chars of the user's message when called from
  // send; the upload path passes "" and we leave the title empty so the
  // session-dropdown's existing localized `window.untitled` fallback kicks
  // in. A follow-up task may back-fill the real title from the first user
  // message — until then this keeps the session list scannable across locales.
  //
  // NOTE: ensureSession does NOT flip `activeSessionId` itself. Callers must
  // seed `chatKeys.messages(sessionId)` in the Query cache BEFORE calling
  // `setActiveSession(sessionId)`, otherwise the first useQuery subscription
  // for the new key reports `isLoading: true` and renders ChatMessageSkeleton
  // for one frame (the "new-chat first-message" white flash).
  const sessionPromiseRef = useRef<Promise<string | null> | null>(null);
  const ensureSession = useCallback(
    async (titleSeed: string): Promise<string | null> => {
      if (effectiveActiveSessionId) return effectiveActiveSessionId;
      if (!activeAgent) return null;
      if (sessionPromiseRef.current) return sessionPromiseRef.current;

      const promise = (async () => {
        try {
          const session = await createSession.mutateAsync({
            agent_id: activeAgent.id,
            title: titleSeed.slice(0, 50),
          });
          return session.id;
        } finally {
          sessionPromiseRef.current = null;
        }
      })();
      sessionPromiseRef.current = promise;
      return promise;
    },
    [effectiveActiveSessionId, activeAgent, createSession],
  );

  const handleUploadFile = useCallback(
    async (file: File) => {
      if (!activeAgent) return null;
      // Uploads are workspace-scoped drafts. Sending the message is the point
      // where we create a chat session (if needed) and bind attachment_ids to
      // the persisted chat_message row. This keeps a paste/drop from creating
      // an empty chat session the user never sends.
      return uploadWithToast(file);
    },
    [activeAgent, uploadWithToast],
  );

  const cancelChatTask = useCallback(
    async (
      taskId: string,
      sessionId: string,
      options: { restoreDraftToInput: boolean; source: string; draftKeyScope?: string },
    ) => {
      apiLogger.info("cancelTask.start", {
        taskId,
        sessionId,
        source: options.source,
      });
      qc.setQueryData(chatKeys.pendingTask(sessionId), {});

      try {
        const result = await api.cancelTaskById(taskId);
        const restored = result.cancelled_chat_message;
        if (restored?.restore_to_input) {
          removeChatMessageFromCaches(qc, restored.chat_session_id, restored.message_id);
          if (options.restoreDraftToInput && restored.chat_session_id === sessionId) {
            setRestoreDraftRequest({
              id: restored.message_id,
              content: restored.content,
              attachments: restored.attachments,
              sessionId: restored.chat_session_id,
              draftKeyScope: options.draftKeyScope,
            });
          }
        }
        qc.invalidateQueries({ queryKey: chatKeys.messages(sessionId) });
        qc.invalidateQueries({ queryKey: chatKeys.messagesPage(sessionId) });
        apiLogger.info("cancelTask.success", {
          taskId,
          sessionId,
          restoredToInput: !!restored?.restore_to_input && options.restoreDraftToInput,
        });
        return result;
      } catch (err) {
        apiLogger.warn("cancelTask.error (task may have already finished)", {
          taskId,
          sessionId,
          err,
        });
        qc.invalidateQueries({ queryKey: chatKeys.messages(sessionId) });
        qc.invalidateQueries({ queryKey: chatKeys.messagesPage(sessionId) });
        return null;
      }
    },
    [qc],
  );

  const handleSend = useCallback(
    async (
      content: string,
      attachmentIds?: string[],
      commitInput?: (options?: { extraDraftKeys?: string[]; clearEditor?: boolean }) => void,
      draftAttachments: Attachment[] = [],
      options: SendChatMessageOptions = {},
    ): Promise<boolean> => {
      if (!activeAgent) {
        apiLogger.warn("sendChatMessage skipped: no active agent");
        return false;
      }

      const finalContent = content;

      const isNewSession = !effectiveActiveSessionId;

      apiLogger.info("sendChatMessage.start", {
        sessionId: effectiveActiveSessionId,
        isNewSession,
        agentId: activeAgent.id,
        replyToThreadTaskId: options.replyToThreadTaskId,
        chatThreadId: options.chatThreadId,
        clientThreadKey: options.clientThreadKey,
        contentLength: finalContent.length,
        attachmentCount: attachmentIds?.length ?? 0,
      });

      let sessionId: string | null = null;
      try {
        sessionId = await ensureSession(finalContent);
      } catch (err) {
        apiLogger.error("sendChatMessage.ensureSession.error", err);
        toast.error(t(($) => $.input.send_failed_toast));
        return false;
      }
      if (!sessionId) {
        apiLogger.warn("sendChatMessage aborted: ensureSession returned null");
        return false;
      }

      // Optimistic burst — everything that gives the user "I sent a message
      // and the agent is now working" feedback fires BEFORE the HTTP roundtrip.
      // Pre-#status-pill the pending-task seed lived after `await
      // sendChatMessage` and the pill blinked in a few hundred ms after the
      // user's message — small but visible "did it actually send?" gap.
      const sentAt = new Date().toISOString();
      const optimisticId = `optimistic-${Date.now()}`;
      const optimisticTaskId = `optimistic-${optimisticId}`;
      const optimisticThreadTaskId = options.replyToThreadTaskId ?? optimisticTaskId;
      const optimistic: ChatMessage = {
        id: optimisticId,
        chat_session_id: sessionId,
        chat_thread_id: options.chatThreadId ?? null,
        client_thread_id: options.clientThreadKey ?? null,
        role: "user",
        content: finalContent,
        task_id: optimisticTaskId,
        thread_task_id: optimisticThreadTaskId,
        created_at: sentAt,
        attachments: draftAttachments,
      };
      // Seed cache BEFORE flipping activeSessionId. If we set the active
      // session first, useQuery's first subscription to the new key sees no
      // cached data and renders ChatMessageSkeleton for one frame — the
      // "new-chat first-message" white flash. Priming the cache first means
      // the very first read after activeSessionId flips hits data
      // synchronously and ChatMessageList mounts directly.
      appendChatMessageToLatestPageCache(qc, sessionId, optimistic);
      qc.setQueryData<ChatMessage[]>(
        chatKeys.messages(sessionId),
        (old) => (old ? [...old, optimistic] : [optimistic]),
      );
      // Seed the pending-task with a temporary id so the StatusPill mounts
      // and starts ticking the instant the user clicks send. Real task_id
      // and server-authoritative created_at land below; until then the pill
      // is anchored to the local clock (drift is the request RTT, ~50–200ms,
      // which doesn't change the rendered "Ns" value).
      qc.setQueryData<ChatPendingTask>(chatKeys.pendingTask(sessionId), {
        task_id: optimisticTaskId,
        status: "queued",
        created_at: sentAt,
      });
      // Cache primed → safe to publish the new active session. But only steal
      // focus if the user is STILL on the compose target they sent from — if
      // they navigated away mid-send, this is fire-and-forget: the reply
      // surfaces via the unread dot on the sent session, we don't yank the
      // view back. Compare the live store against the closure-captured target.
      // For a brand-new chat (activeSessionId === null) the target is keyed by
      // the selected agent, so switching agents to start a different new chat
      // must also count as "navigated away" even though both sides are null.
      const live = useChatStore.getState();
      const stillOnSourceSession =
        live.activeSessionId === effectiveActiveSessionId &&
        (effectiveActiveSessionId !== null || live.selectedAgentId === selectedAgentId);
      if (stillOnSourceSession) {
        setActiveSession(sessionId);
      }
      commitInput?.({
        extraDraftKeys: options.draftKeyScope ? [] : [sessionId],
        clearEditor: stillOnSourceSession,
      });
      apiLogger.debug("sendChatMessage.optimistic", { sessionId, optimisticId: optimistic.id });

      let result;
      try {
        result = await api.sendChatMessage(sessionId, finalContent, attachmentIds, {
          replyToTaskId: options.replyToThreadTaskId,
          chatThreadId: options.chatThreadId,
        });
      } catch (err) {
        apiLogger.error("sendChatMessage.error.rollback", { sessionId, optimisticId: optimistic.id, err });
        stopRequestedBeforeTaskRef.current = false;
        removeChatMessageFromCaches(qc, sessionId, optimistic.id);
        qc.setQueryData(chatKeys.pendingTask(sessionId), {});
        setRestoreDraftRequest({
          id: `send-failed-${optimistic.id}`,
          content: finalContent,
          attachments: draftAttachments,
          // Restore into the session this was sent from. If the user
          // navigated away (fire-and-forget) the request waits until they
          // return rather than dumping content into another session.
          sessionId,
          draftKeyScope: options.draftKeyScope,
        });
        toast.error(t(($) => $.input.send_failed_toast));
        return false;
      }
      apiLogger.info("sendChatMessage.success", {
        sessionId,
        messageId: result.message_id,
        taskId: result.task_id,
        threadTaskId: result.thread_task_id,
        chatThreadId: result.thread_id,
      });
      replaceOptimisticChatMessageId(
        qc,
        sessionId,
        optimistic.id,
        result.message_id,
        result.task_id,
        result.thread_task_id ?? result.task_id,
        result.thread_id ?? null,
      );
      // Replace the temporary task_id with the server's real one (so the WS
      // task: handlers can match against it) and snap the anchor to the
      // server's created_at — keeping the elapsed-seconds reading stable.
      qc.setQueryData<ChatPendingTask>(chatKeys.pendingTask(sessionId), {
        task_id: result.task_id,
        status: "queued",
        created_at: result.created_at,
      });
      if (stopRequestedBeforeTaskRef.current) {
        stopRequestedBeforeTaskRef.current = false;
        await cancelChatTask(result.task_id, sessionId, {
          restoreDraftToInput: true,
          source: "deferred-send",
        });
        return false;
      }
      // The server reports which attachment ids it actually bound. Diff
      // against what we requested so a silent bind failure surfaces to the
      // user — no extra fetch. Skip the check on servers that predate the
      // field (attachment_ids undefined) rather than false-alarm.
      if (attachmentIds && attachmentIds.length > 0 && result.attachment_ids) {
        const boundIds = new Set(result.attachment_ids);
        const missing = attachmentIds.filter((id) => !boundIds.has(id));
        if (missing.length > 0) {
          apiLogger.warn("sendChatMessage.attachments missing after send", {
            sessionId,
            messageId: result.message_id,
            missing,
          });
          toast.error(t(($) => $.input.attachment_bind_failed_toast));
        }
      }
      qc.invalidateQueries({ queryKey: chatKeys.messages(sessionId) });
      qc.invalidateQueries({ queryKey: chatKeys.messagesPage(sessionId) });
      return true;
    },
    [
      effectiveActiveSessionId,
      selectedAgentId,
      activeAgent,
      ensureSession,
      cancelChatTask,
      qc,
      setActiveSession,
      t,
    ],
  );

  const handleThreadReplySend = useCallback(
    (
      chatThreadId: string | null,
      threadTaskId: string | null,
      clientThreadKey: string,
      draftKeyScope: string,
      content: string,
      attachmentIds?: string[],
      commitInput?: (options?: { extraDraftKeys?: string[]; clearEditor?: boolean }) => void,
      draftAttachments: Attachment[] = [],
    ) =>
      handleSend(content, attachmentIds, commitInput, draftAttachments, {
        chatThreadId: chatThreadId ?? undefined,
        replyToThreadTaskId: threadTaskId ?? undefined,
        clientThreadKey,
        draftKeyScope,
      }),
    [handleSend],
  );

  const handleStop = useCallback((options: { draftKeyScope?: string } = {}) => {
    if (!pendingTaskId || !effectiveActiveSessionId) {
      apiLogger.debug("cancelTask skipped: no pending task");
      return;
    }
    if (!isTaskMessageTaskId(pendingTaskId)) {
      stopRequestedBeforeTaskRef.current = true;
      apiLogger.info("cancelTask.deferred until server task id", {
        taskId: pendingTaskId,
        sessionId: effectiveActiveSessionId,
      });
      return;
    }
    void cancelChatTask(pendingTaskId, effectiveActiveSessionId, {
      restoreDraftToInput: true,
      source: "active-input",
      draftKeyScope: options.draftKeyScope,
    });
  }, [pendingTaskId, effectiveActiveSessionId, cancelChatTask]);

  const handleSelectAgent = useCallback(
    (agent: Agent) => {
      // No-op when clicking the already-active agent — don't clobber the
      // current session just because the user closed the menu this way.
      // Compare against activeAgent (what the UI shows), not selectedAgentId
      // (which may be null / point to an archived agent on first load).
      if (activeAgent && agent.id === activeAgent.id) return;
      uiLogger.info("selectAgent", {
        from: selectedAgentId,
        to: agent.id,
        previousSessionId: effectiveActiveSessionId,
      });
      setSelectedAgentId(agent.id);
      // Reset session when switching agent
      setActiveSession(null);
    },
    [activeAgent, selectedAgentId, effectiveActiveSessionId, setSelectedAgentId, setActiveSession],
  );

  const handleNewChat = useCallback(() => {
    uiLogger.info("newChat", {
      previousSessionId: effectiveActiveSessionId,
      previousPendingTask: pendingTaskId,
    });
    setActiveSession(null);
  }, [effectiveActiveSessionId, pendingTaskId, setActiveSession]);

  const handleSelectSession = useCallback(
    (session: ChatSession) => {
      // Sessions are bound 1:1 to an agent — picking a session from a
      // different agent implicitly switches the agent too.
      if (activeAgent && session.agent_id !== activeAgent.id) {
        uiLogger.info("selectSession (cross-agent)", {
          from: activeAgent.id,
          toAgent: session.agent_id,
          toSession: session.id,
        });
        setSelectedAgentId(session.agent_id);
      }
      setActiveSession(session.id);
    },
    [activeAgent, setSelectedAgentId, setActiveSession],
  );

  const handleMinimize = useCallback(() => {
    uiLogger.info("minimize (close)", {
      activeSessionId: effectiveActiveSessionId,
      pendingTaskId,
    });
    setOpen(false);
  }, [effectiveActiveSessionId, pendingTaskId, setOpen]);

  const isExpanded = useChatStore((s) => s.isExpanded);

  const windowRef = useRef<HTMLDivElement>(null);
  const { renderWidth, renderHeight, isAtMax, boundsReady, isDragging, toggleExpand, startDrag } = useChatResize(windowRef);

  // Show the list (vs empty state) as soon as there's anything to display —
  // a real message, or a pending task whose timeline will stream in.
  const hasMessages = messages.length > 0 || !!pendingTaskId;

  const isVisible = isOpen && (isExpanded || boundsReady);

  const containerClass = "absolute bottom-2 right-2 z-50 flex flex-col rounded-xl ring-1 ring-foreground/10 bg-sidebar shadow-2xl overflow-hidden";
  const containerStyle: React.CSSProperties = {
    transformOrigin: "bottom right",
    pointerEvents: isOpen ? "auto" : "none",
  };

  const contextItems = useChatContextItems(wsId);

  const statusBanner = noAgent ? (
    <NoAgentBanner />
  ) : (
    <OfflineBanner agentName={displayAgent?.name ?? activeAgent?.name} availability={availability} />
  );

  const composer = (
    <ChatInput
      onSend={handleSend}
      restoreDraftRequest={restoreDraftRequest}
      onRestoreDraftConsumed={handleRestoreDraftConsumed}
      onUploadFile={handleUploadFile}
      onStop={() => handleStop()}
      isRunning={!!pendingTaskId}
      disabled={isSessionArchived}
      noAgent={noAgent}
      agentName={displayAgent?.name ?? activeAgent?.name}
      leftAdornment={pageMode ? undefined : (
        <AgentDropdown
          agents={availableAgents}
          activeAgent={activeAgent}
          userId={user?.id}
          onSelect={handleSelectAgent}
        />
      )}
      contextItems={contextItems}
    />
  );

  const chatBody = (
    <>
      {/* Messages / skeleton / empty state */}
      {showSkeleton ? (
        <ChatMessageSkeleton />
      ) : hasMessages ? (
        <ChatMessageList
          key={effectiveActiveSessionId}
          messages={messages}
          pendingTask={pendingTask}
          availability={availability}
          firstItemIndex={firstItemIndex}
          hasOlderMessages={!!hasOlderMessages}
          isFetchingOlderMessages={isFetchingOlderMessages}
          onLoadOlderMessages={() => void fetchOlderMessages()}
        />
      ) : (
        <EmptyState
          hasSessions={sessions.length > 0}
          agentName={displayAgent?.name ?? activeAgent?.name}
          onPickPrompt={(text) => handleSend(text)}
        />
      )}

      {/* Status banner above the input — single mutually-exclusive slot.
       *  Priority: no-agent > offline / unstable. Agent presence is the
       *  hard prerequisite (you can't send anything without one), so it
       *  always wins over a presence hint. Recent issue/project navigation
       *  lives in the input action row; it is not message/session state.
       *
       *  We key off `noAgent` (the resolved-empty state) rather than
       *  `!activeAgent`, so the loading window between mount and the
       *  first agent-list response stays banner-free. */}
      {statusBanner}

      {/* Input — disabled for legacy archived sessions; locked out entirely
       *  when there's no agent (the EmptyState above carries the CTA). */}
      {composer}
    </>
  );

  const floatingHeader = (
    <>
      <ChatResizeHandles onDragStart={startDrag} />
      <div className="flex items-center justify-between border-b px-4 py-2.5 gap-2">
        <div className="flex items-center gap-1 min-w-0">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="rounded-full text-muted-foreground"
                  onClick={handleNewChat}
                />
              }
            >
              <Plus />
            </TooltipTrigger>
            <TooltipContent side="top">{t(($) => $.window.new_chat_tooltip)}</TooltipContent>
          </Tooltip>
          <SessionDropdown
            sessions={sessions}
            // Use the full agent list (incl. archived) so historical
            // sessions can still resolve their avatar.
            agents={agents}
            activeSessionId={effectiveActiveSessionId}
            onSelectSession={handleSelectSession}
          />
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  onClick={toggleExpand}
                />
              }
            >
              {isExpanded || isAtMax ? <Minimize2 /> : <Maximize2 />}
            </TooltipTrigger>
            <TooltipContent side="top">
              {isExpanded || isAtMax ? t(($) => $.window.restore_tooltip) : t(($) => $.window.expand_tooltip)}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-muted-foreground"
                  onClick={handleMinimize}
                />
              }
            >
              <Minus />
            </TooltipTrigger>
            <TooltipContent side="top">{t(($) => $.window.minimize_tooltip)}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </>
  );

  if (pageMode) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="shrink-0 border-b bg-background">
          <div className="flex min-h-14 items-center justify-between gap-3 px-5 py-2.5">
            <div className="flex min-w-0 items-center gap-2.5">
              {displayAgent ? (
                <ActorAvatar
                  actorType="agent"
                  actorId={displayAgent.id}
                  size={28}
                  enableHoverCard
                  showStatusDot={!displayAgent.archived_at}
                />
              ) : (
                <span className="size-7 rounded-md bg-muted" />
              )}
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold leading-5">
                  {displayAgent?.name ?? t(($) => $.window.no_agents)}
                </h1>
              </div>
            </div>
            {displayAgent && (
              <AppLink
                href={workspacePaths.agentDetail(displayAgent.id)}
                className="shrink-0 rounded-md px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {t(($) => $.page.show_profile)}
              </AppLink>
            )}
          </div>
          <div className="flex h-9 items-end gap-5 px-5">
            <div className="border-b-2 border-foreground pb-2 text-sm font-medium">
              {t(($) => $.page.chat_tab)}
            </div>
          </div>
        </div>
        <ThreadedChatPageBody
          key={effectiveActiveSessionId ?? routeAgentId ?? "agent-chat"}
          messages={messages}
          pendingTask={pendingTask}
          availability={availability}
          agent={displayAgent}
          user={user}
          showSkeleton={showSkeleton}
          hasOlderMessages={!!hasOlderMessages}
          isFetchingOlderMessages={isFetchingOlderMessages}
          onLoadOlderMessages={() => void fetchOlderMessages()}
          emptyState={(
            <EmptyState
              hasSessions={sessions.length > 0}
              agentName={displayAgent?.name ?? activeAgent?.name}
              onPickPrompt={(text) => handleSend(text)}
            />
          )}
          statusBanner={statusBanner}
          composer={composer}
          onSendThreadReply={handleThreadReplySend}
          restoreDraftRequest={restoreDraftRequest}
          onRestoreDraftConsumed={handleRestoreDraftConsumed}
          onUploadFile={handleUploadFile}
          onStop={handleStop}
          isRunning={!!pendingTaskId}
          disabled={isSessionArchived}
          noAgent={noAgent}
          agentName={displayAgent?.name ?? activeAgent?.name}
          contextItems={contextItems}
        />
      </div>
    );
  }

  if (isAgentChatPath(pathname)) return null;

  return (
    <motion.div
      ref={windowRef}
      className={containerClass}
      style={containerStyle}
      initial={{ opacity: 0, scale: 0.95, width: renderWidth, height: renderHeight }}
      animate={{
        opacity: isVisible ? 1 : 0,
        scale: isVisible ? 1 : 0.95,
        width: renderWidth,
        height: renderHeight,
      }}
      transition={{
        width: isDragging ? { duration: 0 } : { type: "spring", duration: 0.3, bounce: 0 },
        height: isDragging ? { duration: 0 } : { type: "spring", duration: 0.3, bounce: 0 },
        opacity: { duration: 0.15 },
        scale: { type: "spring", duration: 0.2, bounce: 0 },
      }}
    >
      {floatingHeader}
      {chatBody}
    </motion.div>
  );
}

interface ChatThread {
  id: string;
  chatThreadId: string | null;
  threadTaskId: string | null;
  root: ChatMessage;
  replies: ChatMessage[];
}

type ThreadReplySendHandler = (
  chatThreadId: string | null,
  threadTaskId: string | null,
  clientThreadKey: string,
  draftKeyScope: string,
  content: string,
  attachmentIds?: string[],
  commitInput?: (options?: { extraDraftKeys?: string[]; clearEditor?: boolean }) => void,
  draftAttachments?: Attachment[],
) => Promise<boolean>;

type ThreadTimelineEntry =
  | { kind: "standalone-assistant"; message: ChatMessage }
  | { kind: "thread"; thread: ChatThread };

function messageThreadTaskId(message: ChatMessage): string | null {
  return message.thread_task_id ?? message.task_id ?? null;
}

function messageThreadKey(message: ChatMessage): string | null {
  return message.client_thread_id ?? message.chat_thread_id ?? messageThreadTaskId(message);
}

function isThreadReplyMessage(message: ChatMessage): boolean {
  const threadTaskId = message.thread_task_id;
  return !!threadTaskId && !!message.task_id && threadTaskId !== message.task_id;
}

export function buildThreadTimeline(messages: ChatMessage[]): ThreadTimelineEntry[] {
  const timeline: ThreadTimelineEntry[] = [];
  const threadsByThreadKey = new Map<string, ChatThread>();
  const pendingRepliesByThreadKey = new Map<string, ChatMessage[]>();

  const addPendingReply = (threadKey: string, message: ChatMessage) => {
    const pending = pendingRepliesByThreadKey.get(threadKey);
    if (pending) {
      pending.push(message);
    } else {
      pendingRepliesByThreadKey.set(threadKey, [message]);
    }
  };

  const attachPendingReplies = (threadKey: string, thread: ChatThread) => {
    const pending = pendingRepliesByThreadKey.get(threadKey);
    if (!pending) return;
    thread.replies.push(...pending);
    pendingRepliesByThreadKey.delete(threadKey);
  };

  for (const message of messages) {
    const threadKey = messageThreadKey(message);
    const threadTaskId = messageThreadTaskId(message);
    if (message.role === "user") {
      const existingThread = threadKey ? threadsByThreadKey.get(threadKey) : null;
      if (existingThread) {
        existingThread.replies.push(message);
        continue;
      }
      if (threadKey && isThreadReplyMessage(message)) {
        addPendingReply(threadKey, message);
        continue;
      }

      const thread: ChatThread = {
        id: threadKey ?? message.id,
        chatThreadId: message.chat_thread_id ?? null,
        threadTaskId,
        root: message,
        replies: [],
      };
      timeline.push({ kind: "thread", thread });
      if (threadKey) {
        threadsByThreadKey.set(threadKey, thread);
        attachPendingReplies(threadKey, thread);
      }
      continue;
    }

    const thread = threadKey ? threadsByThreadKey.get(threadKey) : null;
    if (thread) {
      thread.replies.push(message);
    } else if (threadKey && isThreadReplyMessage(message)) {
      addPendingReply(threadKey, message);
    } else {
      timeline.push({ kind: "standalone-assistant", message });
    }
  }

  // Fallback: any reply we buffered but never matched to a root (a legacy /
  // racy keying mismatch where a reply's thread key never resolves to a
  // surfaced root) must still be visible — a persisted message is never
  // silently dropped. Surface each orphan in chronological order as its own
  // entry, and warn so the mismatch is observable rather than a black hole.
  if (pendingRepliesByThreadKey.size > 0) {
    const orphans = [...pendingRepliesByThreadKey.values()]
      .flat()
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    for (const message of orphans) {
      if (message.role === "user") {
        timeline.push({
          kind: "thread",
          thread: {
            id: messageThreadKey(message) ?? message.id,
            chatThreadId: message.chat_thread_id ?? null,
            threadTaskId: messageThreadTaskId(message),
            root: message,
            replies: [],
          },
        });
      } else {
        timeline.push({ kind: "standalone-assistant", message });
      }
    }
    uiLogger.warn("buildThreadTimeline: unmatched thread replies surfaced as fallback", {
      orphanCount: orphans.length,
    });
  }

  return timeline;
}

function threadContainsTask(thread: ChatThread, taskId: string): boolean {
  return thread.root.task_id === taskId || thread.replies.some((message) => message.task_id === taskId);
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function sameCalendarDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function formatThreadTimestamp(value: string, todayAt: (time: string) => string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const time = formatMessageTime(value);
  if (sameCalendarDay(date, new Date())) return todayAt(time);
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function ThreadedChatPageBody({
  messages,
  pendingTask,
  availability,
  agent,
  user,
  showSkeleton,
  hasOlderMessages,
  isFetchingOlderMessages,
  onLoadOlderMessages,
  emptyState,
  statusBanner,
  composer,
  onSendThreadReply,
  restoreDraftRequest,
  onRestoreDraftConsumed,
  onUploadFile,
  onStop,
  isRunning,
  disabled,
  noAgent,
  agentName,
  contextItems,
}: {
  messages: ChatMessage[];
  pendingTask: ChatPendingTask | null | undefined;
  availability: AgentAvailability | undefined;
  agent: Agent | null;
  user: User | null;
  showSkeleton: boolean;
  hasOlderMessages: boolean;
  isFetchingOlderMessages: boolean;
  onLoadOlderMessages: () => void;
  emptyState: React.ReactNode;
  statusBanner: React.ReactNode;
  composer: React.ReactNode;
  onSendThreadReply: ThreadReplySendHandler;
  restoreDraftRequest?: {
    id: string;
    content: string;
    attachments?: Attachment[];
    sessionId?: string;
    draftKeyScope?: string;
  } | null;
  onRestoreDraftConsumed?: () => void;
  onUploadFile?: (file: File) => Promise<UploadResult | null>;
  onStop?: (options?: { draftKeyScope?: string }) => void;
  isRunning: boolean;
  disabled: boolean;
  noAgent: boolean;
  agentName?: string;
  contextItems?: MentionItem[];
}) {
  const { t } = useT("chat");
  const timeline = useMemo(() => buildThreadTimeline(messages), [messages]);
  const threads = useMemo(
    () => timeline.filter((entry): entry is { kind: "thread"; thread: ChatThread } => entry.kind === "thread"),
    [timeline],
  );
  const pendingTaskId = pendingTask?.task_id ?? null;
  const canFetchPendingTaskMessages = isTaskMessageTaskId(pendingTaskId);
  const { data: pendingTaskMessages } = useQuery({
    ...taskMessagesOptions(pendingTaskId ?? ""),
    enabled: canFetchPendingTaskMessages,
  });
  const pendingAlreadyPersisted = !!pendingTaskId && messages.some(
    (m) => m.role === "assistant" && m.task_id === pendingTaskId,
  );
  const activePendingThreadId = pendingTaskId
    ? threads.find(({ thread }) => threadContainsTask(thread, pendingTaskId))?.thread.id ?? null
    : null;
  const pendingPlaceholderThreadId = activePendingThreadId && !pendingAlreadyPersisted
    ? activePendingThreadId
    : null;
  const latestThreadId = threads[threads.length - 1]?.thread.id ?? null;
  const previousLatestThreadIdRef = useRef<string | null>(null);
  const previousActivePendingThreadIdRef = useRef<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [panelClosed, setPanelClosed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const [threadPanelWidth, setThreadPanelWidth] = useState(THREAD_PANEL_DEFAULT_WIDTH);
  const [isResizingThreadPanel, setIsResizingThreadPanel] = useState(false);

  useEffect(() => {
    const selectedStillExists = selectedThreadId
      ? threads.some(({ thread }) => thread.id === selectedThreadId)
      : false;
    const latestChanged =
      !!latestThreadId &&
      !!previousLatestThreadIdRef.current &&
      previousLatestThreadIdRef.current !== latestThreadId;
    previousLatestThreadIdRef.current = latestThreadId;
    const activePendingThreadChanged =
      !!activePendingThreadId &&
      previousActivePendingThreadIdRef.current !== activePendingThreadId;
    previousActivePendingThreadIdRef.current = activePendingThreadId;

    if (activePendingThreadChanged && selectedThreadId !== activePendingThreadId) {
      setSelectedThreadId(activePendingThreadId);
      setPanelClosed(false);
      return;
    }

    if (latestChanged && selectedThreadId !== latestThreadId) {
      setSelectedThreadId(latestThreadId);
      setPanelClosed(false);
      return;
    }

    if (!selectedStillExists && latestThreadId && !panelClosed) {
      setSelectedThreadId(latestThreadId);
      return;
    }

    if (selectedThreadId && !selectedStillExists) {
      setSelectedThreadId(panelClosed ? null : latestThreadId);
    }
  }, [activePendingThreadId, latestThreadId, panelClosed, selectedThreadId, threads]);

  const handleThreadResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = threadPanelWidth;
      const containerWidth = containerRef.current?.getBoundingClientRect().width ?? window.innerWidth;
      const maxWidth = Math.max(
        THREAD_PANEL_MIN_WIDTH,
        Math.min(THREAD_PANEL_MAX_WIDTH, containerWidth - THREAD_MAIN_MIN_WIDTH),
      );
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;

      setIsResizingThreadPanel(true);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const nextWidth = startWidth + startX - moveEvent.clientX;
        setThreadPanelWidth(Math.max(THREAD_PANEL_MIN_WIDTH, Math.min(maxWidth, nextWidth)));
      };
      const handlePointerUp = () => {
        setIsResizingThreadPanel(false);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
    },
    [threadPanelWidth],
  );

  const selectedThread = selectedThreadId
    ? threads.find(({ thread }) => thread.id === selectedThreadId)?.thread ?? null
    : null;

  const selectThread = useCallback((threadId: string) => {
    setSelectedThreadId(threadId);
    setPanelClosed(false);
  }, []);

  const closeThread = useCallback(() => {
    setSelectedThreadId(null);
    setPanelClosed(true);
  }, []);

  return (
    <div ref={containerRef} className="flex min-h-0 flex-1 overflow-hidden">
      <div className={cn(
        "flex min-w-0 flex-1 flex-col",
        selectedThread && "hidden lg:flex",
      )}
      >
        <div data-tab-scroll-root className="min-h-0 flex-1 overflow-y-auto">
          {showSkeleton ? (
            <ChatMessageSkeleton />
          ) : timeline.length > 0 ? (
            <div className="mx-auto w-full max-w-4xl space-y-5 px-6 py-4">
              {hasOlderMessages && (
                <div className="flex justify-center">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={isFetchingOlderMessages}
                    onClick={onLoadOlderMessages}
                  >
                    {isFetchingOlderMessages
                      ? t(($) => $.message_list.loading_older)
                      : t(($) => $.thread.load_older)}
                  </Button>
                </div>
              )}
              {timeline.map((entry) => entry.kind === "standalone-assistant" ? (
                <ThreadStandaloneAssistant
                  key={entry.message.id}
                  message={entry.message}
                  agent={agent}
                />
              ) : (
                <ThreadRootItem
                  key={entry.thread.id}
                  thread={entry.thread}
                  agent={agent}
                  user={user}
                  selected={selectedThreadId === entry.thread.id}
                  pending={pendingPlaceholderThreadId === entry.thread.id}
                  pendingTask={pendingPlaceholderThreadId === entry.thread.id ? pendingTask : null}
                  pendingTaskMessages={pendingTaskMessages ?? []}
                  availability={availability}
                  onSelect={() => selectThread(entry.thread.id)}
                />
              ))}
            </div>
          ) : (
            emptyState
          )}
        </div>
        {statusBanner}
        {composer}
      </div>
      <AnimatePresence initial={false}>
        {selectedThread && (
          <motion.div
            key="thread-panel-shell"
            className="flex min-w-0 flex-1 lg:flex-none lg:w-[var(--thread-panel-width)]"
            style={{ "--thread-panel-width": `${threadPanelWidth}px` } as React.CSSProperties}
            initial={{ opacity: 0, x: 28 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 28 }}
            transition={{ type: "spring", duration: 0.28, bounce: 0 }}
          >
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t(($) => $.thread.resize)}
              className="group hidden w-3 shrink-0 cursor-col-resize touch-none select-none items-stretch justify-center lg:flex"
              onPointerDown={handleThreadResizePointerDown}
            >
              <span
                className={cn(
                  "w-px bg-border transition-colors group-hover:bg-foreground/30",
                  isResizingThreadPanel && "bg-brand",
                )}
              />
            </div>
            <ThreadPanel
              thread={selectedThread}
              agent={agent}
              user={user}
              pendingTask={activePendingThreadId === selectedThread.id ? pendingTask : null}
              pendingTaskMessages={pendingTaskMessages ?? []}
              availability={availability}
              onClose={closeThread}
              onSendThreadReply={onSendThreadReply}
              restoreDraftRequest={restoreDraftRequest}
              onRestoreDraftConsumed={onRestoreDraftConsumed}
              onUploadFile={onUploadFile}
              onStop={onStop}
              isRunning={activePendingThreadId === selectedThread.id && isRunning}
              sendBlocked={!!pendingTaskId && activePendingThreadId !== selectedThread.id}
              disabled={disabled}
              noAgent={noAgent}
              agentName={agentName}
              contextItems={contextItems}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ThreadStandaloneAssistant({
  message,
  agent,
}: {
  message: ChatMessage;
  agent: Agent | null;
}) {
  return (
    <div className="flex items-start gap-2.5">
      {agent ? (
        <ActorAvatar actorType="agent" actorId={agent.id} size={34} showStatusDot={!agent.archived_at} profileLink={false} />
      ) : (
        <span className="size-8 rounded-full bg-muted" />
      )}
      <div className="min-w-0 flex-1">
        <MessageAuthorLine
          name={agent?.name ?? "Agent"}
          time={message.created_at}
        />
        <AssistantMessage message={message} isPending={false} />
      </div>
    </div>
  );
}

function ThreadRootItem({
  thread,
  agent,
  user,
  selected,
  pending,
  pendingTask,
  pendingTaskMessages,
  availability,
  onSelect,
}: {
  thread: ChatThread;
  agent: Agent | null;
  user: User | null;
  selected: boolean;
  pending: boolean;
  pendingTask: ChatPendingTask | null | undefined;
  pendingTaskMessages: readonly TaskMessagePayload[];
  availability: AgentAvailability | undefined;
  onSelect: () => void;
}) {
  const { t } = useT("chat");
  const replyCount = thread.replies.length + (pending ? 1 : 0);
  const latestReply = thread.replies[thread.replies.length - 1] ?? null;
  const summaryTime = latestReply?.created_at ?? thread.root.created_at;
  const hasReplySummary = replyCount > 0;
  const replyText = pending
    ? t(($) => $.thread.replying)
    : t(($) => $.thread.reply, { count: replyCount });

  return (
    <div className={cn("rounded-lg py-0.5 transition-colors", selected && "bg-accent/30")}>
      <div className="flex items-start gap-2.5 px-1">
        <ActorAvatar
          actorType="member"
          actorId={user?.id ?? ""}
          size={36}
          profileLink={false}
        />
        <div className="min-w-0 flex-1">
          <MessageAuthorLine
            name={user?.name || user?.email || "You"}
            time={thread.root.created_at}
          />
          <UserMessageContent message={thread.root} />
          {hasReplySummary && (
            <button
              type="button"
              onClick={onSelect}
              className="mt-2 flex items-center gap-2 rounded-md py-0.5 pr-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
            >
              <span className="ml-2 h-6 w-7 rounded-bl-xl border-b border-l border-border" />
              {pending && pendingTask ? (
                <ThreadPendingInlineStatus
                  agent={agent}
                  pendingTask={pendingTask}
                  taskMessages={pendingTaskMessages}
                  availability={availability}
                />
              ) : (
                <>
                  {agent ? (
                    <ActorAvatar actorType="agent" actorId={agent.id} size={18} profileLink={false} />
                  ) : (
                    <span className="size-4 rounded-full bg-muted" />
                  )}
                  <span className="font-medium">{replyText}</span>
                  <span>{formatThreadTimestamp(summaryTime, (time) => t(($) => $.thread.today_at, { time }))}</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ThreadPanel({
  thread,
  agent,
  user,
  pendingTask,
  pendingTaskMessages,
  availability,
  onClose,
  onSendThreadReply,
  restoreDraftRequest,
  onRestoreDraftConsumed,
  onUploadFile,
  onStop,
  isRunning,
  sendBlocked,
  disabled,
  noAgent,
  agentName,
  contextItems,
}: {
  thread: ChatThread;
  agent: Agent | null;
  user: User | null;
  pendingTask: ChatPendingTask | null | undefined;
  pendingTaskMessages: readonly TaskMessagePayload[];
  availability: AgentAvailability | undefined;
  onClose: () => void;
  onSendThreadReply: ThreadReplySendHandler;
  restoreDraftRequest?: {
    id: string;
    content: string;
    attachments?: Attachment[];
    sessionId?: string;
    draftKeyScope?: string;
  } | null;
  onRestoreDraftConsumed?: () => void;
  onUploadFile?: (file: File) => Promise<UploadResult | null>;
  onStop?: (options?: { draftKeyScope?: string }) => void;
  isRunning: boolean;
  sendBlocked?: boolean;
  disabled: boolean;
  noAgent: boolean;
  agentName?: string;
  contextItems?: MentionItem[];
}) {
  const { t } = useT("chat");
  const threadTaskId = thread.threadTaskId ?? messageThreadTaskId(thread.root);
  const chatThreadId = thread.chatThreadId ?? thread.root.chat_thread_id ?? null;
  const draftKeyScope = `thread-${thread.id}`;
  const pendingTaskId = pendingTask?.task_id ?? null;
  const pendingReplyAlreadyPersisted = !!pendingTaskId && thread.replies.some(
    (reply) => reply.role === "assistant" && reply.task_id === pendingTaskId,
  );
  const replyCount = thread.replies.length + (pendingTaskId && !pendingReplyAlreadyPersisted ? 1 : 0);
  const titleName = user?.name || user?.email || "You";

  return (
    <aside className="flex min-w-0 flex-1 flex-col bg-background">
      <div className="flex min-h-14 shrink-0 items-start justify-between gap-3 border-b px-5 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-base font-semibold">
            {t(($) => $.thread.title, { name: titleName })}
          </h2>
          <div className="mt-1 text-sm text-muted-foreground">
            {t(($) => $.thread.reply, { count: replyCount })}
          </div>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 rounded-full text-muted-foreground"
                onClick={onClose}
                aria-label={t(($) => $.thread.close)}
              />
            }
          >
            <X />
          </TooltipTrigger>
          <TooltipContent side="left">{t(($) => $.thread.close)}</TooltipContent>
        </Tooltip>
      </div>
      <div data-tab-scroll-root className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div className="space-y-4">
          <div className="flex items-start gap-2.5">
            <ActorAvatar
              actorType="member"
              actorId={user?.id ?? ""}
              size={34}
              profileLink={false}
            />
            <div className="min-w-0 flex-1">
              <MessageAuthorLine
                name={user?.name || user?.email || "You"}
                time={thread.root.created_at}
              />
              <UserMessageContent message={thread.root} />
            </div>
          </div>

          <div className="flex items-center gap-2.5 text-sm text-muted-foreground">
            <span className="whitespace-nowrap">
              {t(($) => $.thread.reply, { count: replyCount })}
            </span>
            <span className="h-px flex-1 bg-border" />
          </div>

          {thread.replies.map((reply) => (
            <ThreadReplyMessage
              key={reply.id}
              message={reply}
              agent={agent}
              user={user}
              pendingTaskId={pendingTaskId}
            />
          ))}

          {pendingTask?.task_id && !pendingReplyAlreadyPersisted && (
            <ThreadPendingReply
              agent={agent}
              pendingTask={pendingTask}
              taskMessages={pendingTaskMessages}
              availability={availability}
            />
          )}
        </div>
      </div>
      {(chatThreadId || threadTaskId) && (
        <ChatInput
          onSend={(content, attachmentIds, commitInput, draftAttachments) =>
            onSendThreadReply(
              chatThreadId,
              threadTaskId,
              thread.id,
              draftKeyScope,
              content,
              attachmentIds,
              commitInput,
              draftAttachments,
            )}
          restoreDraftRequest={restoreDraftRequest}
          onRestoreDraftConsumed={onRestoreDraftConsumed}
          onUploadFile={onUploadFile}
          onStop={onStop ? () => onStop({ draftKeyScope }) : undefined}
          isRunning={isRunning}
          sendBlocked={sendBlocked}
          disabled={disabled}
          noAgent={noAgent}
          agentName={agentName}
          draftKeyScope={draftKeyScope}
          placeholder={t(($) => $.thread.input_placeholder)}
          contextItems={contextItems}
        />
      )}
    </aside>
  );
}

function ThreadReplyMessage({
  message,
  agent,
  user,
  pendingTaskId,
}: {
  message: ChatMessage;
  agent: Agent | null;
  user: User | null;
  pendingTaskId: string | null;
}) {
  if (message.role === "user") {
    return (
      <div className="flex items-start gap-2.5">
        <ActorAvatar
          actorType="member"
          actorId={user?.id ?? ""}
          size={34}
          profileLink={false}
        />
        <div className="min-w-0 flex-1">
          <MessageAuthorLine
            name={user?.name || user?.email || "You"}
            time={message.created_at}
          />
          <UserMessageContent message={message} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2.5">
      {agent ? (
        <ActorAvatar actorType="agent" actorId={agent.id} size={34} showStatusDot={!agent.archived_at} profileLink={false} />
      ) : (
        <span className="size-8 rounded-full bg-muted" />
      )}
      <div className="min-w-0 flex-1">
        <MessageAuthorLine
          name={agent?.name ?? "Agent"}
          time={message.created_at}
        />
        <AssistantMessage message={message} isPending={message.task_id === pendingTaskId} />
      </div>
    </div>
  );
}

function ThreadPendingReply({
  agent,
  pendingTask,
  taskMessages,
  availability,
}: {
  agent: Agent | null;
  pendingTask: ChatPendingTask;
  taskMessages: readonly TaskMessagePayload[];
  availability: AgentAvailability | undefined;
}) {
  return (
    <div className="flex items-start gap-2.5">
      {agent ? (
        <ActorAvatar actorType="agent" actorId={agent.id} size={34} showStatusDot={!agent.archived_at} profileLink={false} />
      ) : (
        <span className="size-8 rounded-full bg-muted" />
      )}
      <div className="min-w-0 flex-1 pt-0.5">
        <TaskStatusPill
          pendingTask={pendingTask}
          taskMessages={taskMessages}
          availability={availability}
        />
      </div>
    </div>
  );
}

function ThreadPendingInlineStatus({
  agent,
  pendingTask,
  taskMessages,
  availability,
}: {
  agent: Agent | null;
  pendingTask: ChatPendingTask;
  taskMessages: readonly TaskMessagePayload[];
  availability: AgentAvailability | undefined;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-full bg-muted px-1.5 py-1">
      {agent ? (
        <ActorAvatar actorType="agent" actorId={agent.id} size={22} profileLink={false} />
      ) : (
        <span className="size-5 rounded-full bg-background" />
      )}
      <TaskStatusPill
        pendingTask={pendingTask}
        taskMessages={taskMessages}
        availability={availability}
      />
    </div>
  );
}

function MessageAuthorLine({
  name,
  time,
}: {
  name: string;
  time: string;
}) {
  return (
    <div className="mb-0.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="truncate text-sm font-semibold">{name}</span>
      <span className="text-sm text-muted-foreground">{formatMessageTime(time)}</span>
    </div>
  );
}

function UserMessageContent({ message }: { message: ChatMessage }) {
  return (
    <div className="min-w-0 overflow-x-auto text-sm leading-normal prose prose-sm dark:prose-invert max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <Markdown attachments={message.attachments}>{message.content}</Markdown>
      <AttachmentList
        attachments={message.attachments}
        content={message.content}
        className="mt-1.5"
      />
    </div>
  );
}

/**
 * Agent dropdown: avatar trigger, lists all available agents. Selecting a
 * different agent = switch agent + start a fresh chat (session=null).
 * The current agent is marked with a check and not clickable.
 */
export function AgentDropdown({
  agents,
  activeAgent,
  userId,
  onSelect,
}: {
  agents: Agent[];
  activeAgent: Agent | null;
  userId: string | undefined;
  onSelect: (agent: Agent) => void;
}) {
  const { t } = useT("chat");
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  // Split into the user's own agents and everyone else so the menu groups
  // them — matches the old AgentSelector layout.
  const { mine, others } = useMemo(() => {
    const mine: Agent[] = [];
    const others: Agent[] = [];
    for (const a of agents) {
      if (a.owner_id === userId) mine.push(a);
      else others.push(a);
    }
    return { mine, others };
  }, [agents, userId]);

  const query = filter.trim().toLowerCase();
  const matches = (name: string) =>
    !query || name.toLowerCase().includes(query) || matchesPinyin(name, query);
  const filteredMine = mine.filter((agent) => matches(agent.name));
  const filteredOthers = others.filter((agent) => matches(agent.name));

  const handlePick = (agent: Agent) => {
    onSelect(agent);
    setOpen(false);
  };

  if (!activeAgent) {
    return <span className="text-xs text-muted-foreground">{t(($) => $.window.no_agents)}</span>;
  }

  return (
    <PropertyPicker
      open={open}
      onOpenChange={setOpen}
      width="w-64"
      align="start"
      side="top"
      searchable
      searchPlaceholder={t(($) => $.window.agent_filter_placeholder)}
      onSearchChange={setFilter}
      triggerRender={
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 -ml-1 cursor-pointer outline-none transition-colors hover:bg-accent aria-expanded:bg-accent"
        />
      }
      trigger={
        <>
          <ActorAvatar
            actorType="agent"
            actorId={activeAgent.id}
            size={24}
            enableHoverCard
            showStatusDot
          />
          <span className="text-xs font-medium max-w-28 truncate">{activeAgent.name}</span>
          <ChevronDown className="size-3 text-muted-foreground shrink-0" />
        </>
      }
    >
      {filteredMine.length === 0 && filteredOthers.length === 0 ? (
        <PickerEmpty />
      ) : (
        <>
          {filteredMine.length > 0 && (
            <PickerSection label={t(($) => $.window.my_agents)}>
              {filteredMine.map((agent) => (
                <AgentPickerItem
                  key={agent.id}
                  agent={agent}
                  isCurrent={agent.id === activeAgent.id}
                  onSelect={handlePick}
                />
              ))}
            </PickerSection>
          )}
          {filteredOthers.length > 0 && (
            <PickerSection label={t(($) => $.window.others)}>
              {filteredOthers.map((agent) => (
                <AgentPickerItem
                  key={agent.id}
                  agent={agent}
                  isCurrent={agent.id === activeAgent.id}
                  onSelect={handlePick}
                />
              ))}
            </PickerSection>
          )}
        </>
      )}
    </PropertyPicker>
  );
}

function AgentPickerItem({
  agent,
  isCurrent,
  onSelect,
}: {
  agent: Agent;
  isCurrent: boolean;
  onSelect: (agent: Agent) => void;
}) {
  return (
    <PickerItem
      selected={isCurrent}
      onClick={() => onSelect(agent)}
    >
      <ActorAvatar
        actorType="agent"
        actorId={agent.id}
        size={24}
        enableHoverCard
        showStatusDot
      />
      <span className="truncate flex-1">{agent.name}</span>
    </PickerItem>
  );
}

/**
 * Session dropdown: a flat "Chat history" list of all non-archived
 * sessions. Selecting a session from a different agent implicitly
 * switches the agent too
 * (sessions are bound 1:1 to an agent). "New chat" lives in the header's
 * ⊕ button, not inside this dropdown.
 */
function SessionDropdown({
  sessions,
  agents,
  activeSessionId,
  onSelectSession,
}: {
  sessions: ChatSession[];
  agents: Agent[];
  activeSessionId: string | null;
  onSelectSession: (session: ChatSession) => void;
}) {
  const { t } = useT("chat");
  const wsId = useWorkspaceId();
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const title = activeSession?.title?.trim() || t(($) => $.window.untitled);
  const triggerAgent = activeSession ? agentById.get(activeSession.agent_id) ?? null : null;

  // The old soft-archive feature was removed. Pre-existing rows with
  // status='archived' are legacy dead data and are excluded from history.
  const historySessions = useMemo(
    () => sessions.filter((s) => s.status !== "archived"),
    [sessions],
  );

  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [confirmingStopId, setConfirmingStopId] = useState<string | null>(null);
  const [stoppingTaskId, setStoppingTaskId] = useState<string | null>(null);
  const [completedFlashIds, setCompletedFlashIds] = useState<Set<string>>(() => new Set());
  const previousInFlightRef = useRef<Set<string>>(new Set());
  const completedFlashTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Inline rename: only one row can be in edit mode at a time. We track the
  // session id (not the full session) so a stale closure can't overwrite a
  // newer rename pulled in via WS.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const deleteSession = useDeleteChatSession();
  const updateSession = useUpdateChatSession();
  const setActiveSession = useChatStore((s) => s.setActiveSession);
  const queryClient = useQueryClient();
  const formatTimeAgo = useFormatTimeAgo();

  // Aggregate "which sessions have an in-flight task right now". Reuses
  // the same workspace-scoped query the FAB consumes, so toggling the chat
  // window doesn't fire a second request — TanStack dedupes by key.
  const { data: pending } = useQuery(pendingChatTasksOptions(wsId));
  const pendingTaskBySessionId = useMemo(
    () => new Map((pending?.tasks ?? []).map((task) => [task.chat_session_id, task])),
    [pending],
  );
  const inFlightSessionIds = useMemo(
    () => new Set(pendingTaskBySessionId.keys()),
    [pendingTaskBySessionId],
  );

  useEffect(() => {
    const previous = previousInFlightRef.current;
    const unreadSessionIds = new Set(sessions.filter((s) => s.has_unread).map((s) => s.id));

    for (const sessionId of previous) {
      if (inFlightSessionIds.has(sessionId) || !unreadSessionIds.has(sessionId)) continue;

      setCompletedFlashIds((current) => {
        if (current.has(sessionId)) return current;
        return new Set(current).add(sessionId);
      });

      const existingTimer = completedFlashTimersRef.current.get(sessionId);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(() => {
        setCompletedFlashIds((current) => {
          if (!current.has(sessionId)) return current;
          const next = new Set(current);
          next.delete(sessionId);
          return next;
        });
        completedFlashTimersRef.current.delete(sessionId);
      }, 1600);
      completedFlashTimersRef.current.set(sessionId, timer);
    }

    previousInFlightRef.current = inFlightSessionIds;
  }, [inFlightSessionIds, sessions]);

  useEffect(() => {
    const timers = completedFlashTimersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    if (!confirmingStopId || pendingTaskBySessionId.has(confirmingStopId)) return;
    setConfirmingStopId(null);
  }, [confirmingStopId, pendingTaskBySessionId]);

  // Header state split:
  // - inside the trigger: the current chat's own live state
  // - beside the trigger: aggregate activity from other chats
  const currentSessionRunning = activeSessionId ? inFlightSessionIds.has(activeSessionId) : false;
  const otherRunningCount = sessions.filter(
    (s) => s.id !== activeSessionId && inFlightSessionIds.has(s.id),
  ).length;
  const otherUnreadCount = sessions.filter(
    (s) => s.id !== activeSessionId && s.has_unread,
  ).length;

  const handleConfirmDelete = (session: ChatSession) => {
    const sessionId = session.id;
    const isDeletingCurrent = activeSessionId === sessionId;
    // Eager local clear when the user is deleting the session they're
    // currently looking at — otherwise messages / pendingTask queries
    // keep rendering the now-deleted session until chat:session_deleted
    // arrives over WS (~50–200ms gap).
    if (isDeletingCurrent) {
      setActiveSession(null);
    }
    deleteSession.mutate(sessionId, {
      onSettled: () => setConfirmingDeleteId(null),
    });
  };

  const handleSubmitRename = (sessionId: string, raw: string) => {
    const trimmed = raw.trim();
    const current = sessions.find((s) => s.id === sessionId);
    setRenamingId(null);
    // No-op submits (unchanged or blank) skip the network round-trip — the
    // server would reject a blank title anyway, and an unchanged title would
    // just bump updated_at for no user-visible reason.
    if (!trimmed || trimmed === current?.title) return;
    updateSession.mutate({ sessionId, title: trimmed });
  };

  const handleSelectSession = (session: ChatSession) => {
    onSelectSession(session);
    setIsHistoryOpen(false);
  };

  const handleConfirmStop = (session: ChatSession, task: PendingChatTasksResponse["tasks"][number]) => {
    setStoppingTaskId(task.task_id);
    previousInFlightRef.current = new Set(
      [...previousInFlightRef.current].filter((sessionId) => sessionId !== session.id),
    );

    // Same optimistic behavior as the active chat Stop button: remove the
    // running affordance immediately, then let task:cancelled / refetches
    // converge every open surface on the server truth.
    queryClient.setQueryData<PendingChatTasksResponse>(chatKeys.pendingTasks(wsId), (current) => {
      if (!current) return current;
      return {
        ...current,
        tasks: current.tasks.filter((item) => item.task_id !== task.task_id),
      };
    });
    queryClient.setQueryData(chatKeys.pendingTask(session.id), {});
    queryClient.invalidateQueries({ queryKey: chatKeys.messages(session.id) });
    queryClient.invalidateQueries({ queryKey: chatKeys.messagesPage(session.id) });

    api.cancelTaskById(task.task_id).then(
      (result) => {
        const restored = result.cancelled_chat_message;
        if (restored?.restore_to_input) {
          removeChatMessageFromCaches(queryClient, restored.chat_session_id, restored.message_id);
        }
        apiLogger.info("cancelTask.success (history row)", { taskId: task.task_id, sessionId: session.id });
      },
      (err) =>
        apiLogger.warn("cancelTask.error (history row; task may have already finished)", {
          taskId: task.task_id,
          sessionId: session.id,
          err,
        }),
    ).finally(() => {
      queryClient.invalidateQueries({ queryKey: chatKeys.pendingTasks(wsId) });
      queryClient.invalidateQueries({ queryKey: chatKeys.pendingTask(session.id) });
      setStoppingTaskId(null);
      setConfirmingStopId(null);
    });
  };

  const renderRow = (session: ChatSession) => {
    const isCurrent = session.id === activeSessionId;
    const agent = agentById.get(session.agent_id) ?? null;
    const pendingTask = pendingTaskBySessionId.get(session.id);
    const isRunning = !!pendingTask;
    const showCompleted = completedFlashIds.has(session.id) && !isCurrent;
    const showUnread = session.has_unread && !isCurrent;
    const isRenaming = renamingId === session.id;
    const isConfirmingDelete = confirmingDeleteId === session.id;
    const isConfirmingStop = confirmingStopId === session.id && !!pendingTask;
    const isConfirmingAction = isConfirmingDelete || isConfirmingStop;
    const titleText = session.title?.trim() || t(($) => $.window.untitled);
    const trailingStatus = isRunning
      ? t(($) => $.session_history.row_subtitle.working)
      : showCompleted
        ? t(($) => $.session_history.row_subtitle.completed)
        : showUnread
          ? t(($) => $.session_history.row_subtitle.new_reply)
          : formatTimeAgo(session.updated_at);

    return (
      <div
        key={session.id}
        aria-current={isCurrent ? "true" : undefined}
        tabIndex={0}
        onClick={() => {
          if (isRenaming || isConfirmingAction) return;
          handleSelectSession(session);
        }}
        onKeyDown={(e) => {
          if (isRenaming || isConfirmingAction) return;
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          handleSelectSession(session);
        }}
        className={cn(
          "group/history-row relative flex min-h-11 min-w-0 cursor-default items-center gap-2 overflow-hidden rounded-md py-1.5 pl-2 pr-2 outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring",
          isCurrent && "bg-accent/70",
          isConfirmingAction && "bg-destructive/5 hover:bg-destructive/5",
        )}
      >
        {isCurrent && <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-brand" />}
        {agent ? (
          <ActorAvatar
            actorType="agent"
            actorId={agent.id}
            size={24}
            enableHoverCard
            showStatusDot
          />
        ) : (
          <span className="size-6 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          {isRenaming ? (
            <SessionRenameInput
              initialValue={session.title ?? ""}
              onSubmit={(value) => handleSubmitRename(session.id, value)}
              onCancel={() => setRenamingId(null)}
            />
          ) : isConfirmingDelete ? (
            <div className="truncate text-sm font-medium text-destructive">
              {t(($) => $.session_history.delete_dialog.title)}
            </div>
          ) : isConfirmingStop ? (
            <div className="truncate text-sm font-medium text-destructive">
              {t(($) => $.session_history.stop_dialog.title)}
            </div>
          ) : (
            <div
              className={cn("truncate text-sm", (showUnread || showCompleted) && !isRunning && "font-medium")}
              style={{
                maskImage: "linear-gradient(to right, black calc(100% - 18px), transparent)",
                WebkitMaskImage: "linear-gradient(to right, black calc(100% - 18px), transparent)",
              }}
            >
              {titleText}
            </div>
          )}
        </div>
        {!isRenaming && (
          isConfirmingDelete ? (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setConfirmingDeleteId(null);
                }}
                disabled={deleteSession.isPending}
                className="inline-flex h-7 items-center rounded px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {t(($) => $.session_history.delete_dialog.cancel)}
              </button>
              <button
                type="button"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  handleConfirmDelete(session);
                }}
                disabled={deleteSession.isPending}
                className="inline-flex h-7 items-center rounded px-2 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
              >
                {deleteSession.isPending
                  ? t(($) => $.session_history.delete_dialog.confirming)
                  : t(($) => $.session_history.delete_dialog.confirm)}
              </button>
            </div>
          ) : isConfirmingStop && pendingTask ? (
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  setConfirmingStopId(null);
                }}
                disabled={stoppingTaskId === pendingTask.task_id}
                className="inline-flex h-7 items-center rounded px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
              >
                {t(($) => $.session_history.stop_dialog.cancel)}
              </button>
              <button
                type="button"
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  handleConfirmStop(session, pendingTask);
                }}
                disabled={stoppingTaskId === pendingTask.task_id}
                className="inline-flex h-7 items-center rounded px-2 text-[11px] font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50"
              >
                {stoppingTaskId === pendingTask.task_id
                  ? t(($) => $.session_history.stop_dialog.confirming)
                  : t(($) => $.session_history.stop_dialog.confirm)}
              </button>
            </div>
          ) : (
            <div className="flex shrink-0 items-center">
              <div className="flex h-7 items-center justify-end gap-1.5 text-xs text-muted-foreground group-hover/history-row:hidden">
                {isRunning && <Loader2 className="size-3 animate-spin" />}
                {showCompleted && !isRunning && <Check className="size-3 text-emerald-500" />}
                {showUnread && !isRunning && !showCompleted && (
                  <span
                    aria-label={t(($) => $.window.unread)}
                    title={t(($) => $.window.unread)}
                    className="size-1.5 rounded-full bg-brand"
                  />
                )}
                <span className={cn("truncate", (showUnread || showCompleted || isRunning) && "font-medium text-foreground")}>{trailingStatus}</span>
              </div>
              <div className="hidden h-7 items-center gap-0.5 group-hover/history-row:flex">
                {isRunning && pendingTask && (
                  <button
                    type="button"
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      setConfirmingStopId(session.id);
                    }}
                    className="inline-flex h-7 items-center gap-1 rounded px-1.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:outline-none"
                    aria-label={t(($) => $.session_history.row_stop_aria)}
                    title={t(($) => $.session_history.row_stop_aria)}
                  >
                    <Square className="size-2.5 fill-current" />
                    {t(($) => $.session_history.stop_action)}
                  </button>
                )}
                {!isRunning && (
                  <>
                    <button
                      type="button"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        setRenamingId(session.id);
                      }}
                      className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none"
                      aria-label={t(($) => $.session_history.row_rename_aria)}
                      title={t(($) => $.session_history.row_rename_aria)}
                    >
                      <Pencil className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        setConfirmingDeleteId(session.id);
                      }}
                      className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive focus-visible:outline-none"
                      aria-label={t(($) => $.session_history.row_delete_aria)}
                      title={t(($) => $.session_history.row_delete_aria)}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </>
                )}
              </div>
            </div>
          )
        )}
      </div>
    );
  };

  return (
    <>
      <Popover open={isHistoryOpen} onOpenChange={setIsHistoryOpen}>
        <div className="flex min-w-0 items-center gap-1">
          <PopoverTrigger className="flex max-w-96 min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-accent data-[popup-open]:bg-accent data-open:bg-accent">
            {triggerAgent && (
              <ActorAvatar
                actorType="agent"
                actorId={triggerAgent.id}
                size={24}
                enableHoverCard
                showStatusDot
              />
            )}
            <span className="min-w-0 truncate text-sm font-medium">{title}</span>
            {currentSessionRunning && (
              <Loader2
                aria-label={t(($) => $.session_history.row_subtitle.working)}
                className="size-3 shrink-0 animate-spin text-muted-foreground"
              />
            )}
            <ChevronDown className="size-3 text-muted-foreground shrink-0" />
          </PopoverTrigger>
          {otherRunningCount > 0 ? (
            <span
              aria-label={t(($) => $.window.another_running)}
              title={t(($) => $.window.another_running)}
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground"
            >
              <Loader2 className="size-3 animate-spin" />
              {otherRunningCount > 1 && <span>{otherRunningCount}</span>}
            </span>
          ) : otherUnreadCount > 0 ? (
            <span
              aria-label={t(($) => $.window.another_unread)}
              title={t(($) => $.window.another_unread)}
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground"
            >
              <span className="size-1.5 rounded-full bg-brand" />
              {otherUnreadCount > 1 && <span>{otherUnreadCount}</span>}
            </span>
          ) : null}
        </div>
        <PopoverContent
          align="start"
          className="max-h-96 w-auto min-w-[max(16rem,var(--anchor-width,16rem))] max-w-96 gap-0 overflow-y-auto p-1"
          onClick={(e) => e.stopPropagation()}
        >
          {historySessions.length === 0 ? (
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              {t(($) => $.window.no_previous)}
            </div>
          ) : (
            <div role="group" aria-label={t(($) => $.window.history_group)}>
              <div className="px-1.5 py-1 text-xs font-medium text-muted-foreground">
                {t(($) => $.window.history_group)}
              </div>
              {historySessions.map(renderRow)}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </>
  );
}

/**
 * Inline editor for a session title. Mounts focused with the existing
 * title pre-selected so the user can either replace it outright or arrow
 * into the existing text. Enter commits, Escape cancels, a real click
 * outside the input also commits.
 *
 * We do NOT commit on the input's `blur` event: the history popover can
 * move focus to sibling rows and nested actions while the user is still
 * interacting with the panel. Instead a document-level `pointerdown`
 * listener commits only when the user actually clicks outside the input.
 */
function SessionRenameInput({
  initialValue,
  onSubmit,
  onCancel,
}: {
  initialValue: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const { t } = useT("chat");
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  // Hold the latest value + callback in refs so the mount-only effect's
  // listener always sees fresh state without re-subscribing on every
  // keystroke (which would briefly leave a window where pointerdown isn't
  // observed).
  const valueRef = useRef(value);
  valueRef.current = value;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();

    const handlePointerDown = (e: PointerEvent) => {
      const input = inputRef.current;
      if (!input) return;
      if (input.contains(e.target as Node)) return;
      onSubmitRef.current(valueRef.current);
    };
    // Capture phase — commit before outside-click handling can close the
    // popover and unmount this component.
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, []);

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      maxLength={200}
      aria-label={t(($) => $.session_history.row_rename_aria)}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Keep editing keys inside the input instead of letting the row
        // selection keyboard handler consume them.
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          onSubmit(value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className="w-full rounded-sm bg-background px-1 py-0.5 text-sm outline-none ring-1 ring-border focus-visible:ring-brand"
    />
  );
}

function useFormatTimeAgo(): (dateStr: string) => string {
  const { t } = useT("chat");
  return (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return t(($) => $.session_history.time.just_now);
    if (diffMins < 60) return t(($) => $.session_history.time.minutes, { count: diffMins });
    if (diffHours < 24) return t(($) => $.session_history.time.hours, { count: diffHours });
    if (diffDays < 7) return t(($) => $.session_history.time.days, { count: diffDays });
    return date.toLocaleDateString();
  };
}

// Three starter prompts shown on the empty state. Each is keyed into the
// chat namespace so labels translate per locale; the icon stays raw since
// emojis are locale-neutral.
const STARTER_KEYS: ("list_open" | "summarize_today" | "plan_next")[] = [
  "list_open",
  "summarize_today",
  "plan_next",
];
const STARTER_ICONS: Record<(typeof STARTER_KEYS)[number], string> = {
  list_open: "📋",
  summarize_today: "📝",
  plan_next: "💡",
};

function EmptyState({
  hasSessions,
  agentName,
  onPickPrompt,
}: {
  hasSessions: boolean;
  agentName?: string;
  onPickPrompt: (text: string) => void;
}) {
  const { t } = useT("chat");
  // First-time experience: the user has never started a chat in this
  // workspace. Educate before suggesting actions — starter prompts
  // presume the user already knows what chat is for.
  if (!hasSessions) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-8">
        <div className="text-center space-y-3">
          <h3 className="text-base font-semibold">
            {t(($) => $.empty_state.first_time_title)}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t(($) => $.empty_state.first_time_intro)}{" "}
            <span className="font-medium text-foreground">
              {t(($) => $.empty_state.first_time_pillars)}
            </span>
            {t(($) => $.empty_state.first_time_pillars_suffix)}
          </p>
          <p className="text-sm text-muted-foreground">
            {t(($) => $.empty_state.first_time_actions)}
          </p>
        </div>
      </div>
    );
  }

  // Returning user: starter prompts are the fastest path back to action.
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 py-8">
      <div className="text-center space-y-1">
        <h3 className="text-base font-semibold">
          {agentName
            ? t(($) => $.empty_state.returning_title_named, { name: agentName })
            : t(($) => $.empty_state.returning_title_default)}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t(($) => $.empty_state.returning_subtitle)}
        </p>
      </div>
      <div className="w-full max-w-xs space-y-2">
        {STARTER_KEYS.map((key) => {
          const text = t(($) => $.starter_prompts[key]);
          return (
            <button
              key={key}
              type="button"
              onClick={() => onPickPrompt(text)}
              className="w-full rounded-lg border border-border bg-card px-3 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent hover:border-brand/40"
            >
              <span className="mr-2">{STARTER_ICONS[key]}</span>
              {text}
            </button>
          );
        })}
      </div>
    </div>
  );
}
