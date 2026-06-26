package handler

import (
	"context"
	"strings"
	"testing"
)

// TestClaimTask_ThreadResumeSendsOnlyNewUserMessage pins the threaded-chat
// prompt window when the provider session is resumed. A thread carries prior
// user/assistant history AND an active chat_agent_session resume pointer; a new
// user message then arrives. The claim must hand the agent ONLY the new user
// message — the resumed provider session already holds the earlier turns, so
// replaying the whole transcript would double-feed context and grow unbounded
// as the thread lengthens. Guards the daemon.go resume-window split.
func TestClaimTask_ThreadResumeSendsOnlyNewUserMessage(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	ctx := context.Background()
	agentID, runtimeID, daemonID := createRuntimeGuardAgent(t, ctx)

	const (
		oldUserContent = "历史问题：上海天气如何"
		oldAsstContent = "历史回答：上海今天晴。"
		newUserContent = "新的追问：那青岛呢"
		priorSessionID = "resume-provider-session-xyz"
	)

	// Private DM chat session for this agent + creator.
	var sessionID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO chat_session (workspace_id, agent_id, creator_id, title, runtime_id, status, scope_type, source, visibility)
		VALUES ($1, $2, $3, 'thread resume fixture', $4, 'active', 'private_dm', 'app', 'private')
		RETURNING id
	`, testWorkspaceID, agentID, testUserID, runtimeID).Scan(&sessionID); err != nil {
		t.Fatalf("setup: create chat session: %v", err)
	}
	t.Cleanup(func() { testPool.Exec(ctx, `DELETE FROM chat_session WHERE id = $1`, sessionID) })

	// One thread holding the prior history.
	var threadID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO chat_thread (chat_session_id, title, created_by)
		VALUES ($1, 'thread resume fixture', $2)
		RETURNING id
	`, sessionID, testUserID).Scan(&threadID); err != nil {
		t.Fatalf("setup: create chat thread: %v", err)
	}

	// Prior user → assistant turn, then the new unanswered user message. A
	// random thread_task_id stands in for the completed prior turn's task; the
	// window logic keys off role ordering, not the task id.
	if _, err := testPool.Exec(ctx, `
		INSERT INTO chat_message (chat_session_id, chat_thread_id, role, content, thread_task_id, created_at)
		VALUES
			($1, $2, 'user',      $3, gen_random_uuid(), now() - interval '3 minutes'),
			($1, $2, 'assistant', $4, gen_random_uuid(), now() - interval '2 minutes'),
			($1, $2, 'user',      $5, NULL,              now() - interval '1 minute')
	`, sessionID, threadID, oldUserContent, oldAsstContent, newUserContent); err != nil {
		t.Fatalf("setup: insert thread messages: %v", err)
	}

	// Active per-thread resume pointer: this is what makes the claim resume the
	// prior provider session instead of starting fresh.
	if _, err := testPool.Exec(ctx, `
		INSERT INTO chat_agent_session (chat_session_id, chat_thread_id, agent_id, runtime_id, provider_session_id, work_dir, status)
		VALUES ($1, $2, $3, $4, $5, '/tmp/thread-resume-workdir', 'active')
	`, sessionID, threadID, agentID, runtimeID, priorSessionID); err != nil {
		t.Fatalf("setup: insert chat_agent_session: %v", err)
	}

	// Queued chat task bound to the session + thread for the claim to pick up.
	var taskID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, runtime_id, issue_id, status, priority, chat_session_id, chat_thread_id, initiator_user_id)
		VALUES ($1, $2, NULL, 'queued', 2, $3, $4, $5)
		RETURNING id
	`, agentID, runtimeID, sessionID, threadID, testUserID).Scan(&taskID); err != nil {
		t.Fatalf("setup: create queued chat task: %v", err)
	}
	t.Cleanup(func() { testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE id = $1`, taskID) })

	claimed := claimTaskForRuntimeGuard(t, runtimeID, daemonID)

	// Resume hit: the prior provider session is handed back.
	if claimed.PriorSessionID != priorSessionID {
		t.Fatalf("prior_session_id = %q, want %q (resume should hit the chat_agent_session pointer)", claimed.PriorSessionID, priorSessionID)
	}

	// Only the new user message is delivered — no transcript replay.
	if !strings.Contains(claimed.ChatMessage, newUserContent) {
		t.Fatalf("chat_message must contain the new user message %q, got %q", newUserContent, claimed.ChatMessage)
	}
	if strings.Contains(claimed.ChatMessage, oldUserContent) {
		t.Fatalf("chat_message must NOT replay the prior user message %q, got %q", oldUserContent, claimed.ChatMessage)
	}
	if strings.Contains(claimed.ChatMessage, oldAsstContent) {
		t.Fatalf("chat_message must NOT replay the prior assistant message %q, got %q", oldAsstContent, claimed.ChatMessage)
	}
}
