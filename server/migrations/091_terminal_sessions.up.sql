-- terminal_sessions records every interactive PTY a user opens against an
-- agent task workdir via the Issue → Terminal panel or `multica issue
-- terminal`. The row is the audit log entry (RFC §Auth) and the source
-- behind the `type=terminal` rows that surface in `multica issue runs`.
--
-- We keep this lightweight on purpose: keystrokes are NEVER recorded
-- (privacy + volume), only the open/close envelope. close_reason is the
-- string the daemon's terminal.Manager attaches to the teardown
-- (browser_disconnect, idle_timeout, manager_shutdown, ws_disconnect,
-- exited, …) so operators can tell why a session ended without grepping
-- the daemon logs.
CREATE TABLE terminal_sessions (
    id UUID PRIMARY KEY,
    workspace_id UUID NOT NULL,
    issue_id UUID NOT NULL,
    task_id UUID NOT NULL,
    runtime_id UUID,
    user_id UUID NOT NULL,
    work_dir TEXT NOT NULL,
    shell TEXT NOT NULL DEFAULT '',
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    exit_code INTEGER,
    close_reason TEXT NOT NULL DEFAULT ''
);

-- Listing in the issue runs view is always scoped to a single issue and
-- ordered by most-recent-first; this is the dominant access path.
CREATE INDEX terminal_sessions_issue_started_idx
    ON terminal_sessions (issue_id, started_at DESC);

-- Per-workspace audits (e.g. "show me every terminal session in this
-- workspace") and the cross-workspace ACL check both filter by
-- workspace_id first, so a covering index keeps that path cheap.
CREATE INDEX terminal_sessions_workspace_started_idx
    ON terminal_sessions (workspace_id, started_at DESC);
