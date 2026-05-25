-- Per-agent switch controlling whether the Claude runtime merges the host
-- machine's `~/.claude/skills/` into the agent's skill set. 'ignore' (default)
-- isolates the runtime so a broken local skill on one operator's machine can
-- not silently crash a shared agent (GitHub #3052 — Claude exits before
-- reading stdin, leaving the daemon with "broken pipe"). 'merge' preserves the
-- pre-existing behavior for personal agents that intentionally depend on
-- locally installed skills. Workspace skills (`{workDir}/.claude/skills/`)
-- are always loaded — the toggle only governs the user-global directory.
ALTER TABLE agent
    ADD COLUMN skills_local TEXT NOT NULL DEFAULT 'ignore'
    CHECK (skills_local IN ('ignore', 'merge'));
