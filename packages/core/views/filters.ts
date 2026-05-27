import type { ListIssuesParams, SavedView } from "../types";

/**
 * Maps a SavedView's filters JSON to API query params for /api/issues.
 * Keys in the view's filters match the snake_case API param names.
 */
export function viewFiltersToApiParams(
  filters: Record<string, unknown>,
): Partial<ListIssuesParams> {
  const params: Record<string, unknown> = {};

  const directKeys = [
    "assignee_type",
    "statuses",
    "priorities",
    "assignee_filters",
    "include_no_assignee",
    "creator_filters",
    "project_ids",
    "include_no_project",
    "label_ids",
  ] as const;

  for (const key of directKeys) {
    if (filters[key] !== undefined) {
      params[key] = filters[key];
    }
  }

  // Scope-style keys ({me} token preserved — the server resolves it)
  if (filters.assignee !== undefined) params.assignee = filters.assignee;
  if (filters.creator !== undefined) params.creator = filters.creator;
  if (filters.involves !== undefined) params.involves = filters.involves;

  return params as Partial<ListIssuesParams>;
}

/**
 * Whether a view represents a "My Issues" all-scope (has {me} involves
 * token with no narrower assignee/creator constraint). Used to decide
 * whether the union "all" My Issues logic applies.
 */
export function viewIsMyIssuesAll(view: SavedView): boolean {
  const f = view.filters;
  return f.involves === "{me}" && !f.assignee && !f.creator;
}
