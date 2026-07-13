"use client";

import type { Issue } from "@multica/core/types";
import { isJiraIssue, jiraIssueKey } from "@multica/core/types";

export function JiraSourceBadge({ issue, compact = false }: { issue: Issue; compact?: boolean }) {
  if (!isJiraIssue(issue)) return null;
  const key = jiraIssueKey(issue);
  if (!key) return null;
  return (
    <span
      className={
        compact
          ? "inline-flex shrink-0 items-center rounded border border-blue-500/20 bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-300"
          : "inline-flex shrink-0 items-center rounded-md border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300"
      }
      title={`Synced from Jira ${key}`}
    >
      Jira {key}
    </span>
  );
}
