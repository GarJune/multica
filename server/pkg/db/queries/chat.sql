-- name: CreateChatSession :one
INSERT INTO chat_session (
    workspace_id, agent_id, creator_id, title, runtime_id,
    scope_type, scope_id, source, visibility
)
VALUES (
    $1, $2, $3, $4, (SELECT runtime_id FROM agent WHERE id = $2),
    COALESCE(sqlc.narg('scope_type')::text, 'private_dm'),
    COALESCE(sqlc.narg('scope_id')::uuid, $3),
    COALESCE(sqlc.narg('source')::text, 'app'),
    COALESCE(sqlc.narg('visibility')::text, 'private')
)
RETURNING *;

-- name: GetPrivateChatSessionForAgentCreator :one
SELECT * FROM chat_session
WHERE workspace_id = $1
  AND agent_id = $2
  AND creator_id = $3
  AND scope_type = 'private_dm'
  AND source = 'app'
  AND status = 'active'
  AND superseded_by_chat_session_id IS NULL
ORDER BY created_at ASC, id ASC
LIMIT 1;

-- name: GetChatSession :one
SELECT * FROM chat_session
WHERE id = $1;

-- name: GetChatSessionInWorkspace :one
SELECT * FROM chat_session
WHERE id = $1 AND workspace_id = $2;

-- name: ListChatSessionsByCreator :many
-- Returns active sessions with a boolean unread flag. Unread is strictly
-- per-session: either the user has uncleared assistant replies in this
-- session or they don't. Counting messages would be misleading.
SELECT cs.*,
       (cs.unread_since IS NOT NULL)::bool AS has_unread
FROM chat_session cs
WHERE cs.workspace_id = $1 AND cs.creator_id = $2 AND cs.status = 'active'
  AND cs.superseded_by_chat_session_id IS NULL
ORDER BY cs.updated_at DESC;

-- name: ListAllChatSessionsByCreator :many
SELECT cs.*,
       (cs.unread_since IS NOT NULL)::bool AS has_unread
FROM chat_session cs
WHERE cs.workspace_id = $1 AND cs.creator_id = $2
  AND cs.superseded_by_chat_session_id IS NULL
ORDER BY cs.updated_at DESC;

-- name: UpdateChatSessionTitle :one
UPDATE chat_session SET title = $2, updated_at = now()
WHERE id = $1
RETURNING *;

-- name: UpdateChatSessionSession :exec
-- Updates the resume pointer for a chat session. Empty/NULL inputs are
-- ignored via COALESCE so a task that completes without a session_id (e.g.
-- the agent crashed before establishing one) cannot wipe out a previously
-- recorded resume pointer. This makes the chat memory robust against
-- intermittent agent failures.
UPDATE chat_session
SET session_id = COALESCE(sqlc.narg('session_id'), session_id),
    work_dir = COALESCE(sqlc.narg('work_dir'), work_dir),
    runtime_id = COALESCE(sqlc.narg('runtime_id'), runtime_id),
    updated_at = now()
WHERE id = sqlc.arg('id');

-- name: LockChatSessionForDelete :one
-- Acquires an exclusive (FOR UPDATE) row lock on chat_session(id). Used by
-- the delete path so that a concurrent SendChatMessage cannot enqueue a new
-- agent_task_queue row referencing this session between our cancel and
-- delete steps. The FK from agent_task_queue.chat_session_id takes a
-- KEY SHARE lock on the parent row during INSERT validation, which
-- conflicts with FOR UPDATE — concurrent inserts block here and then fail
-- their FK check after we commit the delete.
SELECT id FROM chat_session
WHERE id = $1
FOR UPDATE;

-- name: DeleteChatSession :exec
-- Hard delete. chat_message rows cascade via FK ON DELETE CASCADE; the
-- chat_session_id on agent_task_queue is set NULL by FK so completed/failed
-- task history survives the session being removed. Callers MUST run inside
-- the same transaction that holds LockChatSessionForDelete and that has
-- already cancelled any in-flight tasks (see CancelAgentTasksByChatSession)
-- so the daemon does not keep running work whose result has nowhere to
-- land. workspace_id in the WHERE clause is a SQL-layer tenant guard; see
-- DeleteIssue.
DELETE FROM chat_session WHERE id = $1 AND workspace_id = $2;

-- name: TouchChatSession :exec
UPDATE chat_session SET updated_at = now()
WHERE id = $1;

-- name: CreateChatThread :one
-- Title is capped at 120 chars here so the cap lives in one place (DB), matching
-- SetChatThreadRootMessage's LEFT(...,120); callers may pass the full message.
INSERT INTO chat_thread (chat_session_id, title, created_by)
VALUES ($1, LEFT(sqlc.arg(title)::text, 120), sqlc.arg(created_by))
RETURNING *;

-- name: GetChatThreadInSession :one
SELECT * FROM chat_thread
WHERE id = $1 AND chat_session_id = $2;

-- name: ResolveChatThreadTaskIDByThreadID :one
SELECT COALESCE(thread_task_id, task_id)::uuid
FROM chat_message
WHERE chat_session_id = $1
  AND chat_thread_id = $2
  AND role = 'user'
  AND (thread_task_id IS NOT NULL OR task_id IS NOT NULL)
ORDER BY created_at ASC
LIMIT 1;

-- name: ResolveChatThreadByTaskID :one
SELECT chat_thread_id
FROM chat_message
WHERE chat_session_id = $1
  AND chat_thread_id IS NOT NULL
  AND (
    task_id = $2
    OR thread_task_id = $2
  )
ORDER BY created_at ASC
LIMIT 1;

-- name: GetChatThreadRootMessageByTaskID :one
SELECT * FROM chat_message
WHERE chat_session_id = $1
  AND role = 'user'
  AND (
    task_id = $2
    OR thread_task_id = $2
  )
ORDER BY created_at ASC
LIMIT 1;

-- name: BackfillChatThreadForTaskID :exec
UPDATE chat_message
SET chat_thread_id = $3,
    thread_task_id = COALESCE(thread_task_id, $2)
WHERE chat_session_id = $1
  AND (
    task_id = $2
    OR thread_task_id = $2
  );

-- name: BackfillChatTaskThreadID :exec
UPDATE agent_task_queue
SET chat_thread_id = $2
WHERE id = $1
  AND chat_session_id = $3;

-- name: SetChatThreadRootMessage :exec
UPDATE chat_thread
SET root_message_id = COALESCE(root_message_id, $2),
    title = CASE WHEN title = '' THEN LEFT(sqlc.arg('title'), 120) ELSE title END,
    updated_at = now()
WHERE id = $1;

-- name: CreateChatMessage :one
INSERT INTO chat_message (chat_session_id, chat_thread_id, role, content, task_id, thread_task_id, failure_reason, elapsed_ms)
VALUES ($1, sqlc.narg(chat_thread_id), $2, $3, sqlc.narg(task_id), sqlc.narg(thread_task_id), sqlc.narg(failure_reason), sqlc.narg(elapsed_ms))
RETURNING *;

-- name: LinkChatMessageToTask :exec
UPDATE chat_message
SET task_id = $2,
    thread_task_id = COALESCE(thread_task_id, $2),
    chat_thread_id = COALESCE(chat_thread_id, sqlc.narg('chat_thread_id')::uuid)
WHERE id = $1 AND role = 'user';

-- name: ResolveChatThreadTaskID :one
SELECT COALESCE(thread_task_id, task_id)::uuid
FROM chat_message
WHERE chat_session_id = $1
  AND (
    task_id = $2
    OR thread_task_id = $2
  )
ORDER BY created_at ASC
LIMIT 1;

-- name: GetChatThreadTaskIDByTask :one
SELECT COALESCE(thread_task_id, task_id)::uuid
FROM chat_message
WHERE task_id = $1
ORDER BY role = 'user' DESC, created_at ASC
LIMIT 1;

-- name: DeleteUserChatMessageByTask :one
DELETE FROM chat_message
WHERE task_id = $1 AND role = 'user'
RETURNING *;

-- name: ListChatMessages :many
SELECT * FROM chat_message
WHERE chat_session_id = $1
ORDER BY created_at ASC;

-- name: ListChatMessagesByThread :many
SELECT * FROM chat_message
WHERE chat_session_id = $1
  AND chat_thread_id = $2
ORDER BY created_at ASC;

-- name: ListChatMessagesPage :many
SELECT * FROM chat_message
WHERE chat_session_id = $1
  AND (
    sqlc.narg('before_created_at')::timestamptz IS NULL
    OR (created_at, id) < (sqlc.narg('before_created_at')::timestamptz, sqlc.narg('before_id')::uuid)
  )
ORDER BY created_at DESC, id DESC
LIMIT $2;

-- name: GetChatMessage :one
SELECT * FROM chat_message
WHERE id = $1;

-- name: CreateChatTask :one
INSERT INTO agent_task_queue (
    agent_id, runtime_id, issue_id, status, priority, chat_session_id,
    chat_thread_id, initiator_user_id, force_fresh_session
)
VALUES (
    $1, $2, NULL, 'queued', $3, $4, sqlc.narg('chat_thread_id'), $5,
    COALESCE(sqlc.narg('force_fresh_session')::boolean, FALSE)
)
RETURNING *;

-- name: UpsertChatAgentSession :exec
INSERT INTO chat_agent_session (
    chat_session_id, chat_thread_id, agent_id, runtime_id,
    provider_session_id, work_dir, status, updated_at
)
VALUES (
    $1, $2, $3, $4,
    sqlc.narg('provider_session_id'), sqlc.narg('work_dir'), 'active', now()
)
ON CONFLICT (chat_thread_id, agent_id, runtime_id)
WHERE chat_thread_id IS NOT NULL
DO UPDATE SET
    provider_session_id = COALESCE(EXCLUDED.provider_session_id, chat_agent_session.provider_session_id),
    work_dir = COALESCE(EXCLUDED.work_dir, chat_agent_session.work_dir),
    status = 'active',
    updated_at = now();

-- name: GetChatAgentSessionByThread :one
SELECT * FROM chat_agent_session
WHERE chat_thread_id = $1
  AND agent_id = $2
  AND runtime_id = $3
  AND status = 'active'
LIMIT 1;

-- name: GetLastChatTaskSessionByThread :one
SELECT session_id, work_dir, runtime_id FROM agent_task_queue
WHERE chat_thread_id = $1
  AND (
    status = 'completed'
    OR (
      status = 'failed'
      AND COALESCE(failure_reason, '') NOT IN ('iteration_limit', 'agent_fallback_message', 'api_invalid_request', 'codex_semantic_inactivity')
      AND NOT (COALESCE(error, '') ILIKE '%400%' AND COALESCE(error, '') ILIKE '%invalid_request_error%')
    )
  )
  AND session_id IS NOT NULL
ORDER BY COALESCE(completed_at, started_at, dispatched_at, created_at) DESC
LIMIT 1;

-- name: GetLastChatTaskSession :one
-- Returns the most recent task in this chat session that managed to record a
-- session_id. Includes both completed and failed tasks: even a failed task
-- may have established a real agent session before failing, and we'd rather
-- resume there than start over and lose conversation memory. Used as a
-- fallback when chat_session.session_id is NULL. Resume-unsafe failures are
-- excluded because replaying those sessions deterministically reproduces the
-- same terminal state.
SELECT session_id, work_dir, runtime_id FROM agent_task_queue
WHERE chat_session_id = $1
  AND (
    status = 'completed'
    OR (
      status = 'failed'
      AND COALESCE(failure_reason, '') NOT IN ('iteration_limit', 'agent_fallback_message', 'api_invalid_request', 'codex_semantic_inactivity')
      AND NOT (COALESCE(error, '') ILIKE '%400%' AND COALESCE(error, '') ILIKE '%invalid_request_error%')
    )
  )
  AND session_id IS NOT NULL
ORDER BY completed_at DESC
LIMIT 1;

-- name: GetPendingChatTask :one
-- Returns the most recent in-flight task for a chat session, if any.
-- Used by the frontend to recover pending state after refresh / reopen.
-- created_at is the anchor for the chat StatusPill timer (it computes
-- elapsed = now - task.created_at), so the pill survives refresh / reopen
-- without "resetting to 0s".
SELECT id, status, created_at FROM agent_task_queue
WHERE chat_session_id = $1 AND status IN ('queued', 'dispatched', 'running', 'waiting_local_directory')
ORDER BY created_at DESC
LIMIT 1;

-- name: ListPendingChatTasksByCreator :many
-- Aggregate view of all in-flight chat tasks owned by a given creator in a
-- workspace. Drives the FAB's "running" indicator when the chat window is
-- closed and no single session's query is active.
SELECT atq.id AS task_id, atq.status, atq.chat_session_id
FROM agent_task_queue atq
JOIN chat_session cs ON cs.id = atq.chat_session_id
WHERE cs.workspace_id = $1
  AND cs.creator_id = $2
  AND atq.status IN ('queued', 'dispatched', 'running', 'waiting_local_directory')
ORDER BY atq.created_at DESC;

-- name: MarkChatSessionRead :exec
-- Clears unread_since, dropping the session's unread count to 0.
UPDATE chat_session SET unread_since = NULL
WHERE id = $1;

-- name: SetUnreadSinceIfNull :exec
-- Atomically stamps the first unread assistant message's arrival time.
-- No-op if the session is already in "has unread" state — keeps the earliest
-- unread boundary stable across multiple incoming replies.
UPDATE chat_session SET unread_since = now()
WHERE id = $1 AND unread_since IS NULL;

-- name: GetMostRecentUserChatMessage :one
-- Returns the most recent role='user' message in a session. Used by the
-- Lark `/issue` command parser: when the user types `/issue` with no
-- title, the spec falls back to "use the previous user message as the
-- title". Bot replies (role='assistant') are excluded — only human
-- input qualifies as a fallback title source.
SELECT * FROM chat_message
WHERE chat_session_id = $1 AND role = 'user'
ORDER BY created_at DESC
LIMIT 1;
