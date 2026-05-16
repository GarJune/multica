-- install_token is a single-use, short-lived bearer credential that an
-- authorized workspace member (or autopilot, eventually) mints and pastes
-- into a daemon installer. The installer POSTs the raw token to the
-- exchange endpoint, which atomically marks it used and returns a
-- long-lived daemon_token (mdt_). Phase 1 of RFC MUL-2297 — DB +
-- credential contract only; Phase 2 wires the daemon/CLI side.
--
-- Why a dedicated table instead of reusing daemon_token / PAT:
--   * single-use semantics — used_at + UPDATE ... WHERE used_at IS NULL
--     atomically rejects replay. daemon_token has no such gate.
--   * short TTL — install tokens live ~15 minutes; daemon tokens live
--     100 years. Sharing one row would conflate the two lifecycles.
--   * different prefix (mit_ vs mdt_) so DaemonAuth never accidentally
--     accepts a not-yet-exchanged install token on /api/daemon/*.
CREATE TABLE install_token (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash TEXT NOT NULL,
    workspace_id UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX idx_install_token_hash ON install_token(token_hash);
CREATE INDEX idx_install_token_workspace ON install_token(workspace_id);
