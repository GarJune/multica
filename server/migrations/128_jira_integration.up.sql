-- Jira issue integration: per-member Jira connections, project sync bindings,
-- issue mirror mappings, and sync run audit records.
--
-- Scope:
--   * Polling-only Jira sync. No webhook delivery table is created.
--   * Credentials are encrypted by the application layer before writing
--     jira_connections.encrypted_token; the DB stores ciphertext only.
--   * Jira issue identity is kept in jira_issue_mappings. issue.origin_id
--     points at jira_issue_mappings.id, not at Jira's string issue key/id.

-- =====================
-- jira_connections
-- =====================
-- One row per (workspace, member, Jira site). `member_id` stores the Multica
-- user/member actor that configured this Jira connection; workspace membership
-- is enforced in application code, matching other actor-id columns that can
-- refer to workspace-scoped members.
CREATE TABLE jira_connections (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id        UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    member_id           UUID NOT NULL,
    site_url            TEXT NOT NULL,
    auth_type           TEXT NOT NULL
        CHECK (auth_type IN ('cloud_api_token', 'pat')),
    email               TEXT,
    encrypted_token     TEXT NOT NULL,
    jira_account_id     TEXT NOT NULL,
    jira_display_name   TEXT NOT NULL,
    jira_email          TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, member_id, site_url),
    CHECK (site_url <> ''),
    CHECK (encrypted_token <> ''),
    CHECK (jira_account_id <> ''),
    CHECK (jira_display_name <> ''),
    CHECK (auth_type <> 'cloud_api_token' OR NULLIF(email, '') IS NOT NULL)
);

CREATE INDEX idx_jira_connections_workspace_member
    ON jira_connections(workspace_id, member_id);

-- =====================
-- jira_project_bindings
-- =====================
-- One enabled binding is one polling scope. First version uses fixed
-- 5-minute sync but keeps the interval in DB so the scheduler reads a single
-- source of truth.
CREATE TABLE jira_project_bindings (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id            UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    connection_id           UUID NOT NULL REFERENCES jira_connections(id) ON DELETE CASCADE,
    project_id              TEXT NOT NULL,
    project_key             TEXT NOT NULL,
    project_name            TEXT NOT NULL,
    sync_enabled            BOOLEAN NOT NULL DEFAULT true,
    sync_interval_minutes   INTEGER NOT NULL DEFAULT 5
        CHECK (sync_interval_minutes > 0),
    last_sync_at            TIMESTAMPTZ,
    last_successful_sync_at TIMESTAMPTZ,
    last_error              TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, connection_id, project_key),
    CHECK (project_id <> ''),
    CHECK (project_key <> ''),
    CHECK (project_name <> '')
);

CREATE INDEX idx_jira_project_bindings_due
    ON jira_project_bindings(sync_enabled, last_successful_sync_at);
CREATE INDEX idx_jira_project_bindings_connection
    ON jira_project_bindings(connection_id);

-- =====================
-- jira_issue_mappings
-- =====================
-- Maps one Jira issue to one Multica issue mirror. Jira issue ids are strings;
-- keep them here and use this row's UUID as issue.origin_id.
CREATE TABLE jira_issue_mappings (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id          UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    connection_id         UUID NOT NULL REFERENCES jira_connections(id) ON DELETE CASCADE,
    project_binding_id    UUID NOT NULL REFERENCES jira_project_bindings(id) ON DELETE CASCADE,
    local_issue_id        UUID NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
    jira_issue_id         TEXT NOT NULL,
    jira_key              TEXT NOT NULL,
    jira_project_id       TEXT,
    jira_project_key      TEXT NOT NULL,
    jira_status_name      TEXT,
    jira_status_category  TEXT,
    jira_issue_type       TEXT,
    jira_priority_name    TEXT,
    jira_updated_at       TIMESTAMPTZ,
    last_synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    raw_fields            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, connection_id, jira_issue_id),
    UNIQUE (local_issue_id),
    CHECK (jira_issue_id <> ''),
    CHECK (jira_key <> ''),
    CHECK (jira_project_key <> ''),
    CHECK (jsonb_typeof(raw_fields) = 'object')
);

CREATE INDEX idx_jira_issue_mappings_local_issue
    ON jira_issue_mappings(local_issue_id);
CREATE INDEX idx_jira_issue_mappings_binding_updated
    ON jira_issue_mappings(project_binding_id, jira_updated_at DESC);

-- =====================
-- jira_sync_runs
-- =====================
-- Per-run audit for scheduled and manual syncs. Error text is sanitized by the
-- application layer and must never include tokens or Authorization headers.
CREATE TABLE jira_sync_runs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id        UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    project_binding_id  UUID NOT NULL REFERENCES jira_project_bindings(id) ON DELETE CASCADE,
    run_type            TEXT NOT NULL
        CHECK (run_type IN ('scheduled', 'manual')),
    status              TEXT NOT NULL
        CHECK (status IN ('running', 'success', 'failed')),
    started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at         TIMESTAMPTZ,
    issues_seen         INTEGER NOT NULL DEFAULT 0 CHECK (issues_seen >= 0),
    issues_created      INTEGER NOT NULL DEFAULT 0 CHECK (issues_created >= 0),
    issues_updated      INTEGER NOT NULL DEFAULT 0 CHECK (issues_updated >= 0),
    issues_skipped      INTEGER NOT NULL DEFAULT 0 CHECK (issues_skipped >= 0),
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE INDEX idx_jira_sync_runs_binding_started
    ON jira_sync_runs(project_binding_id, started_at DESC);

-- Extend issue.origin_type to allow Jira mirror issues. `origin_id` stores the
-- jira_issue_mappings.id UUID.
ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_origin_type_check;
ALTER TABLE issue ADD CONSTRAINT issue_origin_type_check
    CHECK (origin_type IN ('autopilot', 'quick_create', 'lark_chat', 'jira'));
