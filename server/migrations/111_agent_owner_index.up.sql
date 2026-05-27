CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_agent_owner ON agent(workspace_id, owner_id);
