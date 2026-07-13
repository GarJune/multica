"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ExternalLink, MessageSquare, RefreshCw } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { Textarea } from "@multica/ui/components/ui/textarea";
import type { Issue } from "@multica/core/types";
import { isJiraIssue, jiraIssueKey, jiraIssueUrl } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { jiraIssueTransitionsOptions } from "@multica/core/jira";
import { useCommentOnJiraIssue, useTransitionJiraIssue } from "@multica/core/jira";
import { openExternal } from "../../platform";
import { JiraSourceBadge } from "./jira-source-badge";

export function JiraActions({ issue }: { issue: Issue }) {
  const wsId = useWorkspaceId();
  const key = jiraIssueKey(issue);
  const url = jiraIssueUrl(issue);
  const [comment, setComment] = useState("");
  const [transitionId, setTransitionId] = useState("");
  const commentMutation = useCommentOnJiraIssue(issue.id);
  const transitionMutation = useTransitionJiraIssue(issue.id);
  const { data } = useQuery({
    ...jiraIssueTransitionsOptions(wsId, issue.id),
    enabled: !!wsId && !!issue.id && isJiraIssue(issue),
  });
  const transitions = data?.transitions ?? [];

  if (!isJiraIssue(issue)) return null;

  async function submitComment() {
    const body = comment.trim();
    if (!body || commentMutation.isPending) return;
    try {
      await commentMutation.mutateAsync({ body });
      setComment("");
      toast.success("Comment posted to Jira");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to comment on Jira");
    }
  }

  async function submitTransition() {
    if (!transitionId || transitionMutation.isPending) return;
    try {
      await transitionMutation.mutateAsync({ transition_id: transitionId });
      setTransitionId("");
      toast.success("Jira status updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update Jira status");
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-blue-500/20 bg-blue-500/[0.03] p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <JiraSourceBadge issue={issue} />
          <p className="text-[11px] text-muted-foreground">
            Jira is the source of truth for synced fields.
          </p>
        </div>
        {url && (
          <Button variant="outline" size="sm" onClick={() => openExternal(url)}>
            <ExternalLink className="h-3.5 w-3.5" />
            Open
          </Button>
        )}
      </div>

      <div className="space-y-2">
        <Textarea
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder={key ? `Comment on ${key}…` : "Comment on Jira…"}
          className="min-h-20 text-xs"
        />
        <Button size="sm" onClick={submitComment} disabled={!comment.trim() || commentMutation.isPending}>
          <MessageSquare className="h-3.5 w-3.5" />
          {commentMutation.isPending ? "Posting…" : "Comment to Jira"}
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <select
          value={transitionId}
          onChange={(event) => setTransitionId(event.target.value)}
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-xs"
        >
          <option value="">{transitions.length ? "Choose Jira transition" : "No Jira transitions"}</option>
          {transitions.map((transition) => (
            <option key={transition.id} value={transition.id}>
              {transition.name}
            </option>
          ))}
        </select>
        <Button size="sm" variant="outline" onClick={submitTransition} disabled={!transitionId || transitionMutation.isPending}>
          <RefreshCw className="h-3.5 w-3.5" />
          {transitionMutation.isPending ? "Updating…" : "Apply"}
        </Button>
      </div>
    </div>
  );
}
