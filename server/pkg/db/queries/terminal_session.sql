-- name: CreateTerminalSession :one
INSERT INTO terminal_sessions (
    id, workspace_id, issue_id, task_id, runtime_id, user_id, work_dir, shell, started_at
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9
) RETURNING *;

-- name: CloseTerminalSession :exec
-- Idempotent: ended_at IS NULL guards against double-close (e.g. the
-- daemon emitting terminal.exit and the user closing the tab racing).
-- A second call after the first has stamped ended_at is a no-op.
UPDATE terminal_sessions
SET ended_at = $2,
    exit_code = $3,
    close_reason = $4
WHERE id = $1 AND ended_at IS NULL;

-- name: ListTerminalSessionsByIssue :many
SELECT * FROM terminal_sessions
WHERE issue_id = $1
ORDER BY started_at DESC;
