CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issue_creator ON issue(workspace_id, creator_id);
