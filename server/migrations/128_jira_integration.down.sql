-- Roll back Jira issue integration schema. Rows with issue.origin_type='jira'
-- would violate the restored CHECK constraint; operators must delete or
-- relabel those issue rows before running this down migration.

ALTER TABLE issue DROP CONSTRAINT IF EXISTS issue_origin_type_check;
ALTER TABLE issue ADD CONSTRAINT issue_origin_type_check
    CHECK (origin_type IN ('autopilot', 'quick_create', 'lark_chat'));

DROP TABLE IF EXISTS jira_sync_runs;
DROP TABLE IF EXISTS jira_issue_mappings;
DROP TABLE IF EXISTS jira_project_bindings;
DROP TABLE IF EXISTS jira_connections;
