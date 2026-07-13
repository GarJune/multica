"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "@multica/ui/components/ui/button";
import { Card, CardContent } from "@multica/ui/components/ui/card";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import { useWorkspaceId } from "@multica/core/hooks";
import {
  jiraConnectionsOptions,
  jiraProjectsOptions,
  jiraProjectBindingsOptions,
  useCreateJiraConnection,
  useCreateJiraProjectBinding,
  useSyncJiraProjectBinding,
} from "@multica/core/jira";

export function JiraTab() {
  const wsId = useWorkspaceId();
  const [siteUrl, setSiteUrl] = useState("");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [authType, setAuthType] = useState<"cloud_api_token" | "pat">("cloud_api_token");
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [selectedProjectKey, setSelectedProjectKey] = useState("");

  const connectionsQuery = useQuery(jiraConnectionsOptions(wsId));
  const bindingsQuery = useQuery(jiraProjectBindingsOptions(wsId));
  const createConnection = useCreateJiraConnection();
  const createBinding = useCreateJiraProjectBinding();
  const syncBinding = useSyncJiraProjectBinding();

  const connections = connectionsQuery.data?.connections ?? [];
  const selectedConnection = connections.find((connection) => connection.id === selectedConnectionId) ?? connections[0];
  const effectiveConnectionId = selectedConnection?.id ?? "";
  const projectsQuery = useQuery(jiraProjectsOptions(wsId, effectiveConnectionId));
  const projects = projectsQuery.data?.projects ?? [];
  const bindings = bindingsQuery.data?.bindings ?? [];
  const selectedProject = projects.find((project) => project.key === selectedProjectKey) ?? projects[0];

  const connectionLabel = useMemo(() => {
    if (!selectedConnection) return "No Jira account connected";
    return `${selectedConnection.jira_display_name} · ${selectedConnection.site_url}`;
  }, [selectedConnection]);

  async function submitConnection() {
    if (!siteUrl.trim() || !token.trim() || createConnection.isPending) return;
    try {
      const connection = await createConnection.mutateAsync({
        site_url: siteUrl.trim(),
        auth_type: authType,
        email: email.trim() || undefined,
        token: token.trim(),
      });
      setSelectedConnectionId(connection.id);
      setToken("");
      toast.success("Jira account connected");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to connect Jira");
    }
  }

  async function submitBinding() {
    if (!effectiveConnectionId || !selectedProject || createBinding.isPending) return;
    try {
      const binding = await createBinding.mutateAsync({
        connection_id: effectiveConnectionId,
        project_id: selectedProject.id,
        project_key: selectedProject.key,
        project_name: selectedProject.name,
        sync_enabled: true,
      });
      await syncBinding.mutateAsync(binding.id);
      toast.success("Jira project sync enabled");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to enable Jira sync");
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Sync unfinished Jira issues assigned to your Jira account into Multica every 5 minutes. Comments and status changes go through Jira.
      </p>

      <Card>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="jira-site-url">Jira site URL</Label>
              <Input id="jira-site-url" placeholder="https://company.atlassian.net" value={siteUrl} onChange={(event) => setSiteUrl(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="jira-auth-type">Auth type</Label>
              <select id="jira-auth-type" value={authType} onChange={(event) => setAuthType(event.target.value as "cloud_api_token" | "pat")} className="h-9 w-full rounded-md border bg-background px-3 text-sm">
                <option value="cloud_api_token">Jira Cloud API token</option>
                <option value="pat">Data Center PAT</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="jira-email">Email</Label>
              <Input id="jira-email" placeholder="you@company.com" value={email} onChange={(event) => setEmail(event.target.value)} />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="jira-token">Token</Label>
              <Input id="jira-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" />
            </div>
          </div>
          <Button onClick={submitConnection} disabled={!siteUrl.trim() || !token.trim() || createConnection.isPending}>
            {createConnection.isPending ? "Connecting…" : "Connect Jira"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">Project sync</p>
            <p className="text-xs text-muted-foreground">{connectionLabel}</p>
          </div>
          {connections.length > 1 && (
            <select value={effectiveConnectionId} onChange={(event) => setSelectedConnectionId(event.target.value)} className="h-9 w-full rounded-md border bg-background px-3 text-sm">
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>{connection.jira_display_name} · {connection.site_url}</option>
              ))}
            </select>
          )}
          <div className="flex gap-2">
            <select value={selectedProject?.key ?? ""} onChange={(event) => setSelectedProjectKey(event.target.value)} className="h-9 min-w-0 flex-1 rounded-md border bg-background px-3 text-sm" disabled={!effectiveConnectionId || projectsQuery.isLoading}>
              {projects.length === 0 ? <option value="">No projects loaded</option> : projects.map((project) => (
                <option key={project.id} value={project.key}>{project.key} · {project.name}</option>
              ))}
            </select>
            <Button onClick={submitBinding} disabled={!effectiveConnectionId || !selectedProject || createBinding.isPending || syncBinding.isPending}>
              {createBinding.isPending || syncBinding.isPending ? "Syncing…" : "Sync project"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="space-y-3">
          <p className="text-sm font-medium">Active Jira syncs</p>
          {bindings.length === 0 ? (
            <p className="text-sm text-muted-foreground">No Jira projects are synced yet.</p>
          ) : (
            <div className="divide-y">
              {bindings.map((binding) => (
                <div key={binding.id} className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{binding.project_key} · {binding.project_name}</p>
                    <p className="text-xs text-muted-foreground">
                      Every {binding.sync_interval_minutes}m · Last sync {binding.last_successful_sync_at ? new Date(binding.last_successful_sync_at).toLocaleString() : "never"}
                    </p>
                    {binding.last_error && <p className="text-xs text-destructive">{binding.last_error}</p>}
                  </div>
                  <Button variant="outline" size="sm" onClick={() => syncBinding.mutate(binding.id)} disabled={syncBinding.isPending}>
                    <RefreshCw className="h-3.5 w-3.5" />
                    Sync now
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
