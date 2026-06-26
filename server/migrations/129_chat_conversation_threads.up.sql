-- Introduce explicit conversation/thread/session boundaries for agent chat.
--
-- `chat_session` remains the persisted conversation container for API
-- compatibility. New rows are scoped so product code can keep one private DM
-- conversation per (workspace, user, agent) while still allowing channel/shared
-- conversations later.

ALTER TABLE chat_session
  ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'private_dm'
    CHECK (scope_type IN ('private_dm', 'channel', 'group', 'legacy', 'custom')),
  ADD COLUMN scope_id UUID,
  ADD COLUMN source TEXT NOT NULL DEFAULT 'app',
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'shared')),
  ADD COLUMN external_ref JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN superseded_by_chat_session_id UUID REFERENCES chat_session(id) ON DELETE SET NULL;

UPDATE chat_session
SET scope_id = creator_id
WHERE scope_id IS NULL;

UPDATE chat_session cs
SET scope_type = 'channel',
    scope_id = ccb.id,
    source = ccb.channel_type,
    visibility = 'shared',
    external_ref = jsonb_build_object(
      'channel_chat_id', ccb.channel_chat_id,
      'chat_type', ccb.chat_type,
      'binding_id', ccb.id
    )
FROM channel_chat_session_binding ccb
WHERE ccb.chat_session_id = cs.id;

CREATE TABLE chat_thread (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_session_id UUID NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
    legacy_chat_session_id UUID REFERENCES chat_session(id) ON DELETE SET NULL,
    legacy_thread_task_id UUID,
    root_message_id UUID,
    title TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'archived')),
    created_by UUID REFERENCES "user"(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_chat_thread_session_updated
  ON chat_thread(chat_session_id, updated_at DESC);
CREATE INDEX idx_chat_thread_legacy_session
  ON chat_thread(legacy_chat_session_id);
CREATE INDEX idx_chat_thread_legacy_task
  ON chat_thread(legacy_thread_task_id)
  WHERE legacy_thread_task_id IS NOT NULL;

ALTER TABLE chat_message
  ADD COLUMN chat_thread_id UUID REFERENCES chat_thread(id) ON DELETE SET NULL;

ALTER TABLE agent_task_queue
  ADD COLUMN chat_thread_id UUID REFERENCES chat_thread(id) ON DELETE SET NULL;

-- PRODUCT DECISION (not a side effect): collapse to exactly ONE private DM
-- conversation per (workspace, agent, creator). Any extra historical private DM
-- sessions a user accumulated with the same agent are merged into the earliest
-- (canonical) one; the others are archived and pointed at it via
-- superseded_by_chat_session_id. Channel conversations are intentionally
-- excluded and stay independent. The reverse of this archival is restored by
-- the down-migration. Validate against a production snapshot before shipping:
-- assert the post-migration active-session count and message/attachment
-- re-parenting match expectations.
WITH canonical_private AS (
  SELECT id,
         FIRST_VALUE(id) OVER (
           PARTITION BY workspace_id, agent_id, creator_id
           ORDER BY created_at ASC, id ASC
         ) AS canonical_id
  FROM chat_session
  WHERE scope_type = 'private_dm'
    AND source = 'app'
    AND superseded_by_chat_session_id IS NULL
)
UPDATE chat_session cs
SET superseded_by_chat_session_id = cp.canonical_id,
    status = 'archived'
FROM canonical_private cp
WHERE cs.id = cp.id
  AND cs.id <> cp.canonical_id;

CREATE UNIQUE INDEX idx_chat_session_scope
  ON chat_session(workspace_id, agent_id, scope_type, scope_id, source)
  WHERE status = 'active' AND superseded_by_chat_session_id IS NULL;

-- Create one thread for every legacy thread-task group inside every old
-- session. The thread lives under the canonical conversation when a private DM
-- session was superseded; channel/shared sessions keep their own container.
WITH thread_groups AS (
  SELECT DISTINCT
      cm.chat_session_id AS legacy_chat_session_id,
      COALESCE(cm.thread_task_id, cm.task_id) AS legacy_thread_task_id
  FROM chat_message cm
  WHERE COALESCE(cm.thread_task_id, cm.task_id) IS NOT NULL
),
roots AS (
  SELECT
      tg.legacy_chat_session_id,
      tg.legacy_thread_task_id,
      root.id AS root_message_id,
      root.content AS root_content,
      root.created_at AS root_created_at
  FROM thread_groups tg
  JOIN LATERAL (
    SELECT cm.*
    FROM chat_message cm
    WHERE cm.chat_session_id = tg.legacy_chat_session_id
      AND COALESCE(cm.thread_task_id, cm.task_id) = tg.legacy_thread_task_id
    ORDER BY (cm.role = 'user') DESC, cm.created_at ASC, cm.id ASC
    LIMIT 1
  ) root ON TRUE
),
targets AS (
  SELECT
      r.*,
      COALESCE(cs.superseded_by_chat_session_id, cs.id) AS chat_session_id,
      cs.creator_id,
      cs.title AS session_title
  FROM roots r
  JOIN chat_session cs ON cs.id = r.legacy_chat_session_id
)
INSERT INTO chat_thread (
    chat_session_id, legacy_chat_session_id, legacy_thread_task_id,
    root_message_id, title, created_by, created_at, updated_at
)
SELECT
    chat_session_id,
    legacy_chat_session_id,
    legacy_thread_task_id,
    root_message_id,
    COALESCE(NULLIF(session_title, ''), LEFT(root_content, 120), ''),
    creator_id,
    root_created_at,
    root_created_at
FROM targets;

-- Sessions with unthreaded legacy messages need one fallback thread.
WITH sessions_with_unthreaded_messages AS (
  SELECT DISTINCT cm.chat_session_id AS legacy_chat_session_id
  FROM chat_message cm
  WHERE COALESCE(cm.thread_task_id, cm.task_id) IS NULL
),
roots AS (
  SELECT
      s.legacy_chat_session_id,
      root.id AS root_message_id,
      root.content AS root_content,
      root.created_at AS root_created_at
  FROM sessions_with_unthreaded_messages s
  JOIN LATERAL (
    SELECT cm.*
    FROM chat_message cm
    WHERE cm.chat_session_id = s.legacy_chat_session_id
      AND COALESCE(cm.thread_task_id, cm.task_id) IS NULL
    ORDER BY (cm.role = 'user') DESC, cm.created_at ASC, cm.id ASC
    LIMIT 1
  ) root ON TRUE
),
targets AS (
  SELECT
      r.*,
      COALESCE(cs.superseded_by_chat_session_id, cs.id) AS chat_session_id,
      cs.creator_id,
      cs.title AS session_title
  FROM roots r
  JOIN chat_session cs ON cs.id = r.legacy_chat_session_id
)
INSERT INTO chat_thread (
    chat_session_id, legacy_chat_session_id, root_message_id,
    title, created_by, created_at, updated_at
)
SELECT
    chat_session_id,
    legacy_chat_session_id,
    root_message_id,
    COALESCE(NULLIF(session_title, ''), LEFT(root_content, 120), ''),
    creator_id,
    root_created_at,
    root_created_at
FROM targets;

-- Attach messages to their new thread and move superseded private DM history
-- onto the canonical conversation.
UPDATE chat_message cm
SET chat_thread_id = ct.id
FROM chat_thread ct
WHERE ct.legacy_chat_session_id = cm.chat_session_id
  AND ct.legacy_thread_task_id IS NOT NULL
  AND COALESCE(cm.thread_task_id, cm.task_id) = ct.legacy_thread_task_id;

UPDATE chat_message cm
SET chat_thread_id = ct.id
FROM chat_thread ct
WHERE ct.legacy_chat_session_id = cm.chat_session_id
  AND ct.legacy_thread_task_id IS NULL
  AND cm.chat_thread_id IS NULL;

UPDATE chat_message cm
SET chat_session_id = ct.chat_session_id
FROM chat_thread ct
WHERE cm.chat_thread_id = ct.id
  AND cm.chat_session_id <> ct.chat_session_id;

ALTER TABLE chat_thread
  ADD CONSTRAINT chat_thread_root_message_fkey
  FOREIGN KEY (root_message_id) REFERENCES chat_message(id) ON DELETE SET NULL;

-- Bind tasks to threads via their user/assistant chat message link, then move
-- superseded private DM tasks onto the canonical conversation id.
UPDATE agent_task_queue atq
SET chat_thread_id = cm.chat_thread_id
FROM chat_message cm
WHERE cm.task_id = atq.id
  AND cm.chat_thread_id IS NOT NULL
  AND atq.chat_session_id IS NOT NULL;

UPDATE agent_task_queue atq
SET chat_session_id = ct.chat_session_id
FROM chat_thread ct
WHERE atq.chat_thread_id = ct.id
  AND atq.chat_session_id IS DISTINCT FROM ct.chat_session_id;

-- Move unattached chat uploads that were scoped only to a superseded private
-- DM conversation so restored drafts can still re-bind in the canonical one.
UPDATE attachment a
SET chat_session_id = cs.superseded_by_chat_session_id
FROM chat_session cs
WHERE a.chat_session_id = cs.id
  AND cs.superseded_by_chat_session_id IS NOT NULL
  AND a.chat_message_id IS NULL;

CREATE INDEX idx_chat_message_session_thread
  ON chat_message(chat_session_id, chat_thread_id, created_at)
  WHERE chat_thread_id IS NOT NULL;
CREATE INDEX idx_agent_task_queue_chat_thread_pending
  ON agent_task_queue(chat_thread_id, created_at DESC)
  WHERE chat_thread_id IS NOT NULL
    AND status IN ('queued', 'dispatched', 'running', 'waiting_local_directory');

CREATE TABLE chat_agent_session (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chat_session_id UUID NOT NULL REFERENCES chat_session(id) ON DELETE CASCADE,
    chat_thread_id UUID REFERENCES chat_thread(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agent(id) ON DELETE CASCADE,
    runtime_id UUID NOT NULL REFERENCES agent_runtime(id) ON DELETE CASCADE,
    provider_session_id TEXT,
    work_dir TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'poisoned')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_chat_agent_session_thread_runtime
  ON chat_agent_session(chat_thread_id, agent_id, runtime_id)
  WHERE chat_thread_id IS NOT NULL;

CREATE INDEX idx_chat_agent_session_session
  ON chat_agent_session(chat_session_id, updated_at DESC);

INSERT INTO chat_agent_session (
    chat_session_id, chat_thread_id, agent_id, runtime_id,
    provider_session_id, work_dir, updated_at
)
SELECT DISTINCT ON (atq.chat_thread_id, atq.agent_id, atq.runtime_id)
    atq.chat_session_id,
    atq.chat_thread_id,
    atq.agent_id,
    atq.runtime_id,
    atq.session_id,
    atq.work_dir,
    COALESCE(atq.completed_at, atq.started_at, atq.dispatched_at, atq.created_at)
FROM agent_task_queue atq
WHERE atq.chat_thread_id IS NOT NULL
  AND atq.chat_session_id IS NOT NULL
  AND atq.session_id IS NOT NULL
  AND (
    atq.status = 'completed'
    OR (
      atq.status = 'failed'
      AND COALESCE(atq.failure_reason, '') NOT IN ('iteration_limit', 'agent_fallback_message', 'api_invalid_request', 'codex_semantic_inactivity')
      AND NOT (COALESCE(atq.error, '') ILIKE '%400%' AND COALESCE(atq.error, '') ILIKE '%invalid_request_error%')
    )
  )
ORDER BY
    atq.chat_thread_id,
    atq.agent_id,
    atq.runtime_id,
    COALESCE(atq.completed_at, atq.started_at, atq.dispatched_at, atq.created_at) DESC;
