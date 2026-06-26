-- Reverse the private-DM merge first, while the bookkeeping columns still
-- exist: the up-migration archived every non-canonical private DM session and
-- pointed it at its canonical via superseded_by_chat_session_id. Restore those
-- rows to 'active' so the set of usable conversations is the same as before the
-- migration. (Message/task/attachment rows that were re-parented onto the
-- canonical conversation are not moved back — that history stays consolidated —
-- but no conversation is left silently archived by a rollback.)
UPDATE chat_session
SET status = 'active'
WHERE superseded_by_chat_session_id IS NOT NULL
  AND status = 'archived';

DROP TABLE IF EXISTS chat_agent_session;

DROP INDEX IF EXISTS idx_agent_task_queue_chat_thread_pending;
DROP INDEX IF EXISTS idx_chat_message_session_thread;

ALTER TABLE agent_task_queue
  DROP COLUMN IF EXISTS chat_thread_id;

ALTER TABLE chat_thread
  DROP CONSTRAINT IF EXISTS chat_thread_root_message_fkey;

ALTER TABLE chat_message
  DROP COLUMN IF EXISTS chat_thread_id;

DROP TABLE IF EXISTS chat_thread;

DROP INDEX IF EXISTS idx_chat_session_scope;

ALTER TABLE chat_session
  DROP COLUMN IF EXISTS superseded_by_chat_session_id,
  DROP COLUMN IF EXISTS external_ref,
  DROP COLUMN IF EXISTS visibility,
  DROP COLUMN IF EXISTS source,
  DROP COLUMN IF EXISTS scope_id,
  DROP COLUMN IF EXISTS scope_type;
