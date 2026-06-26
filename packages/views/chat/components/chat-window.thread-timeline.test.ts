import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@multica/core/types";

// chat-window.tsx pulls in actor-avatar at module load; stub it so importing
// the pure buildThreadTimeline helper doesn't drag in avatar rendering deps.
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: () => null,
}));

import { buildThreadTimeline } from "./chat-window";

function msg(overrides: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">): ChatMessage {
  return {
    chat_session_id: "s1",
    content: overrides.id,
    task_id: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as ChatMessage;
}

function countSurfaced(timeline: ReturnType<typeof buildThreadTimeline>): number {
  return timeline.reduce((sum, entry) => {
    if (entry.kind === "thread") return sum + 1 + entry.thread.replies.length;
    return sum + 1;
  }, 0);
}

describe("buildThreadTimeline", () => {
  it("groups a root with its thread replies under one thread", () => {
    const messages: ChatMessage[] = [
      msg({ id: "u1", role: "user", task_id: "t1", thread_task_id: "t1", chat_thread_id: "th1" }),
      msg({ id: "a1", role: "assistant", task_id: "t1", thread_task_id: "t1", chat_thread_id: "th1" }),
      msg({ id: "u2", role: "user", task_id: "t2", thread_task_id: "t1", chat_thread_id: "th1" }),
    ];
    const timeline = buildThreadTimeline(messages);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.kind).toBe("thread");
    expect(countSurfaced(timeline)).toBe(messages.length);
  });

  it("never drops a reply whose thread key never matches a surfaced root (message conservation)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Reply keyed only by chat_thread_id 'orphan-th', but no root ever carries
    // that key — the legacy/racy mismatch the fallback must catch.
    const messages: ChatMessage[] = [
      msg({ id: "u1", role: "user", task_id: "t1", thread_task_id: "t1", chat_thread_id: "th1" }),
      msg({
        id: "a1",
        role: "assistant",
        task_id: "t2",
        thread_task_id: "t99",
        chat_thread_id: "orphan-th",
      }),
    ];
    const timeline = buildThreadTimeline(messages);
    // Both messages remain visible even though the assistant reply orphaned.
    expect(countSurfaced(timeline)).toBe(messages.length);
    warn.mockRestore();
  });
});
