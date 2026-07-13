import type { Issue } from "./issue";

export interface JiraConnection {
  id: string;
  workspace_id: string;
  member_id: string;
  site_url: string;
  auth_type: "cloud_api_token" | "pat";
  email: string | null;
  jira_account_id: string;
  jira_display_name: string;
  jira_email: string | null;
  created_at: string;
  updated_at: string;
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  project_type_key: string;
  avatar_url: string;
}

export interface JiraProjectBinding {
  id: string;
  workspace_id: string;
  connection_id: string;
  project_id: string;
  project_key: string;
  project_name: string;
  sync_enabled: boolean;
  sync_interval_minutes: number;
  last_sync_at: string | null;
  last_successful_sync_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface JiraSyncRun {
  id: string;
  workspace_id: string;
  project_binding_id: string;
  run_type: "scheduled" | "manual";
  status: "running" | "success" | "failed";
  started_at: string;
  finished_at: string | null;
  issues_seen: number;
  issues_created: number;
  issues_updated: number;
  issues_skipped: number;
  error_message: string | null;
}

export interface JiraTransition {
  id: string;
  name: string;
  to_status_name: string;
  to_status_category: string;
}

export interface JiraCommentResult {
  jira_comment_id: string;
  body: string;
  created_at: string;
  author_display_name: string;
}

export interface ListJiraConnectionsResponse {
  connections: JiraConnection[];
}

export interface ListJiraProjectsResponse {
  projects: JiraProject[];
}

export interface ListJiraProjectBindingsResponse {
  bindings: JiraProjectBinding[];
}

export interface CreateJiraConnectionRequest {
  site_url: string;
  auth_type: "cloud_api_token" | "pat";
  email?: string;
  token: string;
}

export interface CreateJiraProjectBindingRequest {
  connection_id: string;
  project_id: string;
  project_key: string;
  project_name: string;
  sync_enabled?: boolean;
}

export interface SyncJiraProjectBindingResponse {
  sync_run: JiraSyncRun;
}

export interface ListJiraTransitionsResponse {
  transitions: JiraTransition[];
}

export interface CreateJiraCommentRequest {
  body: string;
}

export interface CreateJiraCommentResponse {
  comment: JiraCommentResult;
  issue: Issue;
}

export interface TransitionJiraIssueRequest {
  transition_id: string;
}

export interface TransitionJiraIssueResponse {
  issue: Issue;
}

export function isJiraIssue(issue: { metadata?: Record<string, unknown> }): boolean {
  return issue?.metadata?.["source"] === "jira";
}

export function jiraIssueKey(issue: { metadata?: Record<string, unknown> }): string | null {
  const key = issue?.metadata?.["jiraKey"];
  return typeof key === "string" ? key : null;
}

export function jiraIssueUrl(issue: { metadata?: Record<string, unknown> }): string | null {
  const url = issue?.metadata?.["jiraUrl"];
  return typeof url === "string" ? url : null;
}