"use client";

import { useMemo } from "react";
import { useStore } from "zustand";
import { Button } from "@multica/ui/components/ui/button";
import type { Issue, SavedView } from "@multica/core/types";
import { myIssuesViewStore } from "@multica/core/issues/stores/my-issues-view-store";
import { useT } from "../../i18n";
import { WorkspaceAgentWorkingChip } from "../../issues/components/workspace-agent-working-chip";
import { IssueDisplayControls } from "../../issues/components/issues-header";

export function MyIssuesHeader({
  allIssues,
  views,
  activeViewId,
  onSelectView,
}: {
  allIssues: Issue[];
  views?: SavedView[];
  activeViewId?: string | null;
  onSelectView?: (id: string) => void;
}) {
  const { t: tIssues } = useT("issues");
  const agentRunningFilter = useStore(myIssuesViewStore, (s) => s.agentRunningFilter);
  const act = myIssuesViewStore.getState();
  const scopedIssueIds = useMemo(
    () => new Set(allIssues.map((i) => i.id)),
    [allIssues],
  );

  return (
    <div className="flex h-12 shrink-0 items-center justify-between px-4">
      <div className="flex items-center gap-1">
        {views?.map((v) => (
          <Button
            key={v.id}
            variant="outline"
            size="sm"
            className={
              activeViewId === v.id
                ? "bg-accent text-accent-foreground hover:bg-accent/80"
                : "text-muted-foreground"
            }
            onClick={() => onSelectView?.(v.id)}
          >
            {v.name}
          </Button>
        ))}
      </div>

      <div className="flex items-center gap-1">
        {agentRunningFilter && (
          <span className="mr-1 text-xs text-muted-foreground">
            {tIssues(($) => $.agent_activity.filter_active_label)}
          </span>
        )}
        <WorkspaceAgentWorkingChip
          value={agentRunningFilter}
          onToggle={act.toggleAgentRunningFilter}
          scopedIssueIds={scopedIssueIds}
        />
        <IssueDisplayControls scopedIssues={allIssues} />
      </div>
    </div>
  );
}
