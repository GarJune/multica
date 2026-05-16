-- name: CreateDaemonToken :one
INSERT INTO daemon_token (token_hash, workspace_id, daemon_id, expires_at)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: GetDaemonTokenByHash :one
-- revoked_at IS NULL filters out tokens explicitly revoked via the runtime
-- UX flow (RFC MUL-2297). expires_at > now() stays for defense in depth even
-- though Phase 1 mints tokens with a ~100-year expiry — the legacy short-TTL
-- behavior is still legal and the cleanup query depends on it.
SELECT * FROM daemon_token
WHERE token_hash = $1
  AND revoked_at IS NULL
  AND expires_at > now();

-- name: RevokeDaemonTokenByID :one
-- Marks a single daemon_token revoked. Returns token_hash so the caller can
-- invalidate auth.DaemonTokenCache before the 10-minute TTL would otherwise
-- let a revoked token keep authenticating on a cached lookup.
UPDATE daemon_token
SET revoked_at = now()
WHERE id = $1
  AND workspace_id = $2
  AND revoked_at IS NULL
RETURNING token_hash;

-- name: DeleteDaemonTokensByWorkspaceAndDaemons :many
-- Deletes every daemon_token row matching the (workspace_id, daemon_id)
-- pairs implied by `daemon_ids`. Used by the member-revocation flow to
-- nuke tokens for all runtimes a leaving member owned in one shot.
-- Returns token_hash so the caller can invalidate auth.DaemonTokenCache
-- before the 10-minute TTL expires — without that invalidate, a daemon
-- can keep using its stale token until cache eviction even though the
-- DB row is gone.
DELETE FROM daemon_token
WHERE workspace_id = @workspace_id
  AND daemon_id = ANY(@daemon_ids::text[])
RETURNING token_hash;

-- name: DeleteExpiredDaemonTokens :exec
DELETE FROM daemon_token
WHERE expires_at <= now();
