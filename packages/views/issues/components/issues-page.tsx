"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronRight, ListTodo } from "lucide-react";
import type { UpdateIssueRequest } from "@multica/core/types";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useIssueViewStore, useClearFiltersOnWorkspaceChange } from "@multica/core/issues/stores/view-store";
import { ViewStoreProvider } from "@multica/core/issues/stores/view-store-context";
import { filterIssues } from "../utils/filter";
import { BOARD_STATUSES } from "@multica/core/issues/config";
import { useCurrentWorkspace } from "@multica/core/paths";
import { WorkspaceAvatar } from "../../workspace/workspace-avatar";
import { useWorkspaceId } from "@multica/core/hooks";
import { issueListOptions, childIssueProgressOptions } from "@multica/core/issues/queries";
import { agentTaskSnapshotOptions } from "@multica/core/agents";
import { useUpdateIssue } from "@multica/core/issues/mutations";
import { useIssueSelectionStore } from "@multica/core/issues/stores/selection-store";
import { viewListOptions } from "@multica/core/views/queries";
import { viewFiltersToApiParams } from "@multica/core/views/filters";
import { PageHeader } from "../../layout/page-header";
import { IssuesHeader } from "./issues-header";
import { BoardView } from "./board-view";
import { ListView } from "./list-view";
import { SwimLaneView } from "./swimlane-view";
import { BatchActionToolbar } from "./batch-action-toolbar";
import type { ChildProgress } from "./list-row";
import { useT } from "../../i18n";

const EMPTY_CHILD_PROGRESS = new Map<string, ChildProgress>();

export function IssuesPage() {
  const { t } = useT("issues");
  const wsId = useWorkspaceId();

  const workspace = useCurrentWorkspace();
  const viewMode = useIssueViewStore((s) => s.viewMode);
  const statusFilters = useIssueViewStore((s) => s.statusFilters);
  const priorityFilters = useIssueViewStore((s) => s.priorityFilters);
  const assigneeFilters = useIssueViewStore((s) => s.assigneeFilters);
  const includeNoAssignee = useIssueViewStore((s) => s.includeNoAssignee);
  const creatorFilters = useIssueViewStore((s) => s.creatorFilters);
  const projectFilters = useIssueViewStore((s) => s.projectFilters);
  const includeNoProject = useIssueViewStore((s) => s.includeNoProject);
  const labelFilters = useIssueViewStore((s) => s.labelFilters);
  const sortBy = useIssueViewStore((s) => s.sortBy);
  const sortDirection = useIssueViewStore((s) => s.sortDirection);
  const agentRunningFilter = useIssueViewStore((s) => s.agentRunningFilter);

  const sort = useMemo(
    () => ({
      sort_by: sortBy,
      sort_direction: sortBy !== "position" ? sortDirection : undefined,
    } as const),
    [sortBy, sortDirection],
  );

  // --- Views ---
  const { data: views = [] } = useQuery(viewListOptions(wsId, { page: "issues" }));
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const activeView = useMemo(
    () => views.find((v) => v.id === activeViewId) ?? views.find((v) => v.is_default) ?? views[0],
    [views, activeViewId],
  );
  useEffect(() => {
    if (views.length > 0 && !activeViewId) {
      const defaultView = views.find((v) => v.is_default) ?? views[0];
      if (defaultView) setActiveViewId(defaultView.id);
    }
  }, [views, activeViewId]);

  const viewFilter = useMemo(
    () => (activeView ? viewFiltersToApiParams(activeView.filters) : {}),
    [activeView],
  );

  const { data: snapshot = [] } = useQuery(agentTaskSnapshotOptions(wsId));
  const runningIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of snapshot) {
      if (t.status === "running" && t.issue_id) ids.add(t.issue_id);
    }
    return ids;
  }, [snapshot]);

  // Server-side filter from the active view, merged with client-side filter overrides
  const serverFilter = useMemo(() => {
    const f = { ...viewFilter };
    if (statusFilters.length > 0) f.statuses = statusFilters;
    if (priorityFilters.length > 0) f.priorities = priorityFilters;
    if (assigneeFilters.length > 0) f.assignee_filters = assigneeFilters;
    if (includeNoAssignee) f.include_no_assignee = true;
    if (creatorFilters.length > 0) f.creator_filters = creatorFilters;
    if (projectFilters.length > 0) f.project_ids = projectFilters;
    if (includeNoProject) f.include_no_project = true;
    if (labelFilters.length > 0) f.label_ids = labelFilters;
    return f;
  }, [viewFilter, statusFilters, priorityFilters, assigneeFilters, includeNoAssignee, creatorFilters, projectFilters, includeNoProject, labelFilters]);

  const statusIssuesQuery = useQuery({
    ...issueListOptions(wsId, serverFilter, sort),
  });
  const allIssues = useMemo(
    () => statusIssuesQuery.data ?? [],
    [statusIssuesQuery.data],
  );
  const loading = statusIssuesQuery.isLoading;

  useClearFiltersOnWorkspaceChange(useIssueViewStore, wsId);

  useEffect(() => {
    useIssueSelectionStore.getState().clear();
  }, [viewMode, activeViewId]);

  // Client-side filters that can't be done server-side (agent running filter)
  const issues = useMemo(
    () => filterIssues(allIssues, { statusFilters: [], priorityFilters: [], assigneeFilters: [], includeNoAssignee: false, creatorFilters: [], projectFilters: [], includeNoProject: false, labelFilters: [], agentRunningFilter, runningIssueIds }),
    [allIssues, agentRunningFilter, runningIssueIds],
  );

  const swimlaneIssues = useMemo(
    () => filterIssues(allIssues, { statusFilters: [], priorityFilters: [], assigneeFilters: [], includeNoAssignee: false, creatorFilters: [], projectFilters: [], includeNoProject: false, labelFilters: [], agentRunningFilter, runningIssueIds }),
    [allIssues, agentRunningFilter, runningIssueIds],
  );

  const { data: childProgressMap = EMPTY_CHILD_PROGRESS } = useQuery(childIssueProgressOptions(wsId));

  const visibleStatuses = useMemo(() => {
    if (statusFilters.length > 0)
      return BOARD_STATUSES.filter((s) => statusFilters.includes(s));
    return BOARD_STATUSES;
  }, [statusFilters]);

  const hiddenStatuses = useMemo(() => {
    return BOARD_STATUSES.filter((s) => !visibleStatuses.includes(s));
  }, [visibleStatuses]);

  const updateIssueMutation = useUpdateIssue();
  const handleMoveIssue = useCallback(
    (issueId: string, updates: Pick<UpdateIssueRequest, "status" | "assignee_type" | "assignee_id" | "position" | "parent_issue_id">, onSettled?: () => void) => {
      updateIssueMutation.mutate(
        { id: issueId, ...updates },
        {
          onError: (err) =>
            toast.error(
              err instanceof Error && err.message
                ? err.message
                : t(($) => $.page.move_failed),
            ),
          onSettled: () => onSettled?.(),
        },
      );
    },
    [updateIssueMutation, t],
  );

  const contentSkeleton = viewMode === "list" ? (
    <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full rounded-lg" />
      ))}
    </div>
  ) : (
    <div className="flex flex-1 min-h-0 gap-4 overflow-x-auto p-4">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex min-w-52 flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="h-24 w-full rounded-lg" />
        </div>
      ))}
    </div>
  );

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <PageHeader className="gap-1.5">
        <WorkspaceAvatar name={workspace?.name ?? "W"} size="sm" />
        <span className="text-sm text-muted-foreground">
          {workspace?.name ?? t(($) => $.page.breadcrumb_workspace_fallback)}
        </span>
        <ChevronRight className="h-3 w-3 text-muted-foreground" />
        <span className="text-sm font-medium">{t(($) => $.page.breadcrumb_title)}</span>
      </PageHeader>

      <ViewStoreProvider store={useIssueViewStore}>
        <IssuesHeader
          scopedIssues={issues}
          views={views}
          activeViewId={activeView?.id ?? null}
          onSelectView={setActiveViewId}
        />

        {loading ? contentSkeleton : issues.length === 0 ? (
          <div className="flex flex-1 min-h-0 flex-col items-center justify-center gap-2 text-muted-foreground">
            <ListTodo className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm">{t(($) => $.page.empty_title)}</p>
            <p className="text-xs">{t(($) => $.page.empty_hint)}</p>
          </div>
        ) : (
          <div className="flex flex-col flex-1 min-h-0">
            {viewMode === "board" ? (
              <BoardView
                issues={issues}
                visibleStatuses={visibleStatuses}
                hiddenStatuses={hiddenStatuses}
                onMoveIssue={handleMoveIssue}
                childProgressMap={childProgressMap}
                sort={sort}
                viewFilter={serverFilter}
              />
            ) : viewMode === "swimlane" ? (
              <SwimLaneView
                issues={issues}
                unfilteredIssues={swimlaneIssues}
                visibleStatuses={visibleStatuses}
                hiddenStatuses={hiddenStatuses}
                onMoveIssue={handleMoveIssue}
                childProgressMap={childProgressMap}
                sort={sort}
              />
            ) : (
              <ListView issues={issues} visibleStatuses={visibleStatuses} childProgressMap={childProgressMap} sort={sort} onMoveIssue={handleMoveIssue} viewFilter={serverFilter} />
            )}
          </div>
        )}
        {viewMode === "list" && <BatchActionToolbar />}
      </ViewStoreProvider>
    </div>
  );
}
