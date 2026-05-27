CREATE TABLE saved_view (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  creator_id    UUID REFERENCES "user"(id) ON DELETE SET NULL,

  name          TEXT NOT NULL,
  page          TEXT NOT NULL,       -- 'issues' | 'my_issues' | 'project'
  project_id    UUID REFERENCES project(id) ON DELETE CASCADE,

  filters       JSONB NOT NULL DEFAULT '{}',

  position      FLOAT8 NOT NULL DEFAULT 0,
  shared        BOOLEAN NOT NULL DEFAULT false,
  is_default    BOOLEAN NOT NULL DEFAULT false,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_saved_view_unique ON saved_view(
  workspace_id, page,
  COALESCE(project_id, '00000000-0000-0000-0000-000000000000'),
  name
);
CREATE INDEX idx_saved_view_workspace ON saved_view(workspace_id);
CREATE INDEX idx_saved_view_page ON saved_view(workspace_id, page);

-- Hot-table performance indexes moved to migration 111 (CONCURRENTLY).
