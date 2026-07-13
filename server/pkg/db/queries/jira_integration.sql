-- =====================
-- Jira Connections
-- =====================

-- name: UpsertJiraConnection :one
INSERT INTO jira_connections (
    workspace_id, member_id, site_url, auth_type, email,
    encrypted_token, jira_account_id, jira_display_name, jira_email
) VALUES (
    $1, $2, $3, $4, sqlc.narg('email'),
    $5, $6, $7, sqlc.narg('jira_email')
)
ON CONFLICT (workspace_id, member_id, site_url) DO UPDATE SET
    auth_type = EXCLUDED.auth_type,
    email = EXCLUDED.email,
    encrypted_token = EXCLUDED.encrypted_token,
    jira_account_id = EXCLUDED.jira_account_id,
    jira_display_name = EXCLUDED.jira_display_name,
    jira_email = EXCLUDED.jira_email,
    updated_at = now()
RETURNING *;

-- name: GetJiraConnectionInWorkspace :one
SELECT * FROM jira_connections
WHERE id = $1
  AND workspace_id = $2;

-- name: GetJiraConnectionInWorkspaceForMember :one
SELECT * FROM jira_connections
WHERE id = $1
  AND workspace_id = $2
  AND member_id = $3;

-- name: ListJiraConnectionsForMember :many
SELECT * FROM jira_connections
WHERE workspace_id = $1
  AND member_id = $2
ORDER BY created_at ASC;

-- name: DeleteJiraConnectionForMember :exec
DELETE FROM jira_connections
WHERE id = $1
  AND workspace_id = $2
  AND member_id = $3;

-- =====================
-- Jira Project Bindings
-- =====================

-- name: UpsertJiraProjectBinding :one
INSERT INTO jira_project_bindings (
    workspace_id, connection_id, project_id, project_key, project_name,
    sync_enabled, sync_interval_minutes
) VALUES (
    $1, $2, $3, $4, $5,
    COALESCE(sqlc.narg('sync_enabled')::boolean, true),
    COALESCE(sqlc.narg('sync_interval_minutes')::integer, 5)
)
ON CONFLICT (workspace_id, connection_id, project_key) DO UPDATE SET
    project_id = EXCLUDED.project_id,
    project_name = EXCLUDED.project_name,
    sync_enabled = EXCLUDED.sync_enabled,
    sync_interval_minutes = EXCLUDED.sync_interval_minutes,
    updated_at = now()
RETURNING *;

-- name: GetJiraProjectBinding :one
SELECT * FROM jira_project_bindings
WHERE id = $1;

-- name: GetJiraProjectBindingForMember :one
SELECT b.*
FROM jira_project_bindings b
JOIN jira_connections c ON c.id = b.connection_id
WHERE b.id = $1
  AND b.workspace_id = $2
  AND c.member_id = $3;

-- name: ListJiraProjectBindingsForMember :many
SELECT b.*
FROM jira_project_bindings b
JOIN jira_connections c ON c.id = b.connection_id
WHERE b.workspace_id = $1
  AND c.member_id = $2
ORDER BY b.created_at ASC;

-- name: ListDueJiraProjectBindings :many
SELECT * FROM jira_project_bindings
WHERE sync_enabled = true
  AND (
    last_successful_sync_at IS NULL
    OR last_sync_at IS NULL
    OR last_sync_at + (sync_interval_minutes * interval '1 minute') <= sqlc.arg('now')::timestamptz
  )
ORDER BY COALESCE(last_successful_sync_at, 'epoch'::timestamptz) ASC, created_at ASC;

-- name: UpdateJiraProjectBindingSyncStarted :one
UPDATE jira_project_bindings
SET last_sync_at = $2,
    updated_at = now()
WHERE id = $1
RETURNING *;

-- name: UpdateJiraProjectBindingSyncSucceeded :one
UPDATE jira_project_bindings
SET last_successful_sync_at = $2,
    last_error = NULL,
    updated_at = now()
WHERE id = $1
RETURNING *;

-- name: UpdateJiraProjectBindingSyncFailed :one
UPDATE jira_project_bindings
SET last_error = $2,
    updated_at = now()
WHERE id = $1
RETURNING *;

-- =====================
-- Jira Issue Mappings
-- =====================

-- name: GetJiraIssueMappingByJiraID :one
SELECT * FROM jira_issue_mappings
WHERE workspace_id = $1
  AND connection_id = $2
  AND jira_issue_id = $3;

-- name: GetJiraIssueMappingByIssueID :one
SELECT * FROM jira_issue_mappings
WHERE workspace_id = $1
  AND local_issue_id = $2;

-- name: CreateJiraIssueMapping :one
INSERT INTO jira_issue_mappings (
    id, workspace_id, connection_id, project_binding_id, local_issue_id,
    jira_issue_id, jira_key, jira_project_id, jira_project_key,
    jira_status_name, jira_status_category, jira_issue_type,
    jira_priority_name, jira_updated_at, last_synced_at, raw_fields
) VALUES (
    $1, $2, $3, $4, $5,
    $6, $7, sqlc.narg('jira_project_id'), $8,
    sqlc.narg('jira_status_name'), sqlc.narg('jira_status_category'), sqlc.narg('jira_issue_type'),
    sqlc.narg('jira_priority_name'), sqlc.narg('jira_updated_at'), $9,
    COALESCE(sqlc.narg('raw_fields')::jsonb, '{}'::jsonb)
)
RETURNING *;

-- name: UpdateJiraIssueMapping :one
UPDATE jira_issue_mappings
SET jira_key = $2,
    jira_project_id = sqlc.narg('jira_project_id'),
    jira_project_key = $3,
    jira_status_name = sqlc.narg('jira_status_name'),
    jira_status_category = sqlc.narg('jira_status_category'),
    jira_issue_type = sqlc.narg('jira_issue_type'),
    jira_priority_name = sqlc.narg('jira_priority_name'),
    jira_updated_at = sqlc.narg('jira_updated_at'),
    last_synced_at = $4,
    raw_fields = COALESCE(sqlc.narg('raw_fields')::jsonb, raw_fields),
    updated_at = now()
WHERE id = $1
RETURNING *;

-- name: DeleteJiraIssueMappingByIssueID :exec
DELETE FROM jira_issue_mappings
WHERE workspace_id = $1
  AND local_issue_id = $2;

-- =====================
-- Jira Sync Runs
-- =====================

-- name: CreateJiraSyncRun :one
INSERT INTO jira_sync_runs (
    workspace_id, project_binding_id, run_type, status, started_at
) VALUES (
    $1, $2, $3, 'running', $4
)
RETURNING *;

-- name: FinishJiraSyncRun :one
UPDATE jira_sync_runs
SET status = $2,
    finished_at = $3,
    issues_seen = $4,
    issues_created = $5,
    issues_updated = $6,
    issues_skipped = $7,
    error_message = sqlc.narg('error_message'),
    updated_at = now()
WHERE id = $1
RETURNING *;

-- name: ListJiraSyncRunsForBinding :many
SELECT * FROM jira_sync_runs
WHERE workspace_id = $1
  AND project_binding_id = $2
ORDER BY started_at DESC
LIMIT $3 OFFSET $4;
