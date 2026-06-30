import type { Issue } from "@multica/core/types";

/** Small "Jira" badge shown on issues that were synced from Jira (their
 *  metadata carries `source === "jira"`). Links out to the Jira issue when a
 *  `jira_url` is present. Renders nothing for user-created issues. */
export function JiraBadge({ issue }: { issue: Pick<Issue, "metadata"> }) {
  if (issue.metadata?.source !== "jira") return null;
  const url = typeof issue.metadata.jira_url === "string" ? issue.metadata.jira_url : "";

  const label = (
    <span className="inline-flex shrink-0 items-center rounded-full border border-border px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
      Jira
    </span>
  );

  if (!url) return label;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="shrink-0"
    >
      {label}
    </a>
  );
}
