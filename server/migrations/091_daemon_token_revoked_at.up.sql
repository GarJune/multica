-- daemon_token.revoked_at flips the credential from "short-lived auto-expiry"
-- to "long-lived until explicitly revoked". Phase 1 of the runtime UX
-- refactor (RFC MUL-2297): once the install_token / mdt_ flow is wired up
-- (Phase 2+), an issued daemon token sticks until the workspace owner
-- revokes its runtime — so users no longer need to re-paste a token on a
-- schedule. expires_at stays NOT NULL and is set to ~now()+100y at mint
-- time, which is functionally equivalent to "no expiry" while keeping the
-- DeleteExpiredDaemonTokens cleanup path intact.
ALTER TABLE daemon_token
    ADD COLUMN revoked_at TIMESTAMPTZ NULL;
