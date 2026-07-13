import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

export const jiraKeys = {
  all: (wsId: string) => ["jira", wsId] as const,
  connections: (wsId: string) => [...jiraKeys.all(wsId), "connections"] as const,
  projects: (wsId: string, connectionId: string) => [...jiraKeys.all(wsId), "projects", connectionId] as const,
  bindings: (wsId: string) => [...jiraKeys.all(wsId), "bindings"] as const,
  transitions: (wsId: string, issueId: string) => [...jiraKeys.all(wsId), "transitions", issueId] as const,
};

export const jiraConnectionsOptions = (wsId: string) =>
  queryOptions({
    queryKey: jiraKeys.connections(wsId),
    queryFn: () => api.listJiraConnections(),
    enabled: !!wsId,
  });

export const jiraProjectsOptions = (wsId: string, connectionId: string) =>
  queryOptions({
    queryKey: jiraKeys.projects(wsId, connectionId),
    queryFn: () => api.listJiraProjects(connectionId),
    enabled: !!wsId && !!connectionId,
  });

export const jiraProjectBindingsOptions = (wsId: string) =>
  queryOptions({
    queryKey: jiraKeys.bindings(wsId),
    queryFn: () => api.listJiraProjectBindings(),
    enabled: !!wsId,
  });

export const jiraIssueTransitionsOptions = (wsId: string, issueId: string) =>
  queryOptions({
    queryKey: jiraKeys.transitions(wsId, issueId),
    queryFn: () => api.listJiraIssueTransitions(issueId),
    enabled: !!wsId && !!issueId,
  });
