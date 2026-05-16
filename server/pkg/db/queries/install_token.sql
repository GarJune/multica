-- name: CreateInstallToken :one
INSERT INTO install_token (token_hash, workspace_id, created_by, expires_at)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: ConsumeInstallToken :one
-- Atomically validates and burns an install_token in a single statement. The
-- caller passes the SHA-256 hash of the raw mit_ token; the row is selected
-- only when it is unexpired AND not yet consumed, and the same UPDATE sets
-- used_at = now() so a concurrent second exchange returns zero rows. Callers
-- distinguish "wrong/expired" from "already used" by re-querying after a
-- miss (see handler.ExchangeInstallToken).
UPDATE install_token
SET used_at = now()
WHERE token_hash = $1
  AND used_at IS NULL
  AND expires_at > now()
RETURNING *;

-- name: GetInstallTokenByHash :one
-- Read-only lookup used after ConsumeInstallToken returns zero rows, so the
-- handler can tell "no such token / expired" apart from "already consumed"
-- and return the install_token_already_used error code that Phase 2's
-- daemon installer expects.
SELECT * FROM install_token
WHERE token_hash = $1;

-- name: DeleteExpiredInstallTokens :exec
DELETE FROM install_token
WHERE expires_at <= now();
