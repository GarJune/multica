import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useWorkspaceId } from "../hooks";
import { issueKeys } from "../issues/queries";
import type {
  CreateJiraCommentRequest,
  CreateJiraConnectionRequest,
  CreateJiraProjectBindingRequest,
  TransitionJiraIssueRequest,
} from "../types";
import { jiraKeys } from "./queries";

export function useCreateJiraConnection() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (data: CreateJiraConnectionRequest) => api.createJiraConnection(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: jiraKeys.connections(wsId) });
    },
  });
}

export function useCreateJiraProjectBinding() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (data: CreateJiraProjectBindingRequest) => api.createJiraProjectBinding(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: jiraKeys.bindings(wsId) });
    },
  });
}

export function useSyncJiraProjectBinding() {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (bindingId: string) => api.syncJiraProjectBinding(bindingId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: jiraKeys.bindings(wsId) });
      qc.invalidateQueries({ queryKey: issueKeys.list(wsId) });
      qc.invalidateQueries({ queryKey: issueKeys.myAll(wsId) });
    },
  });
}

export function useCommentOnJiraIssue(issueId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (data: CreateJiraCommentRequest) => api.commentOnJiraIssue(issueId, data),
    onSuccess: (res) => {
      qc.setQueryData(issueKeys.detail(wsId, issueId), res.issue);
      qc.invalidateQueries({ queryKey: issueKeys.timeline(issueId) });
      qc.invalidateQueries({ queryKey: issueKeys.list(wsId) });
      qc.invalidateQueries({ queryKey: issueKeys.myAll(wsId) });
    },
  });
}

export function useTransitionJiraIssue(issueId: string) {
  const qc = useQueryClient();
  const wsId = useWorkspaceId();
  return useMutation({
    mutationFn: (data: TransitionJiraIssueRequest) => api.transitionJiraIssue(issueId, data),
    onSuccess: (res) => {
      qc.setQueryData(issueKeys.detail(wsId, issueId), res.issue);
      qc.invalidateQueries({ queryKey: issueKeys.list(wsId) });
      qc.invalidateQueries({ queryKey: issueKeys.myAll(wsId) });
      qc.invalidateQueries({ queryKey: jiraKeys.transitions(wsId, issueId) });
    },
  });
}
