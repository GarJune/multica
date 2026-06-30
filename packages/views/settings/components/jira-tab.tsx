"use client";

import { useEffect, useState } from "react";
import { Button } from "@multica/ui/components/ui/button";
import { Card, CardContent } from "@multica/ui/components/ui/card";
import { Input } from "@multica/ui/components/ui/input";
import { Label } from "@multica/ui/components/ui/label";
import { Textarea } from "@multica/ui/components/ui/textarea";
import { getJiraBridge, useJiraSync } from "../jira/use-jira-sync";

interface JiraFormState {
  siteUrl: string;
  email: string;
  apiToken: string;
  jql: string;
  pollIntervalMinutes: number;
  statusMappingText: string;
}

const EMPTY_FORM: JiraFormState = {
  siteUrl: "",
  email: "",
  apiToken: "",
  jql: "assignee = currentUser() ORDER BY updated DESC",
  pollIntervalMinutes: 0,
  statusMappingText: "{}",
};

/** Jira → Multica one-way sync settings. Desktop-only: the Jira REST calls run
 *  in the Electron main process (via window.jiraAPI) to bypass browser CORS, so
 *  on web we render a notice instead of the form. */
export function JiraTab() {
  const isDesktop = !!getJiraBridge();
  const { syncNow, running, lastResult, error } = useJiraSync();
  const [form, setForm] = useState<JiraFormState>(EMPTY_FORM);
  const [hasToken, setHasToken] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    const bridge = getJiraBridge();
    if (!bridge) return;
    void bridge.getConfig().then((cfg) => {
      setForm({
        siteUrl: cfg.siteUrl,
        email: cfg.email,
        apiToken: "",
        jql: cfg.jql,
        pollIntervalMinutes: cfg.pollIntervalMinutes,
        statusMappingText: JSON.stringify(cfg.statusMapping ?? {}, null, 2),
      });
      setHasToken(cfg.hasToken === true);
    });
  }, [isDesktop]);

  if (!isDesktop) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          Jira sync is only available in the Multica desktop app.
        </CardContent>
      </Card>
    );
  }

  const onSave = async () => {
    const bridge = getJiraBridge();
    if (!bridge) return;
    setSaveMessage(null);
    let statusMapping: Record<string, string>;
    try {
      statusMapping = JSON.parse(form.statusMappingText || "{}") as Record<string, string>;
    } catch {
      setSaveMessage("Status mapping must be valid JSON.");
      return;
    }
    await bridge.setConfig({
      siteUrl: form.siteUrl.trim(),
      email: form.email.trim(),
      // Empty token means "leave the stored token unchanged" (see main process).
      apiToken: form.apiToken,
      jql: form.jql,
      pollIntervalMinutes: Number(form.pollIntervalMinutes) || 0,
      statusMapping,
    });
    setHasToken(hasToken || form.apiToken.length > 0);
    setForm((f) => ({ ...f, apiToken: "" }));
    setSaveMessage("Saved.");
  };

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="space-y-2">
          <Label htmlFor="jira-site">Jira site URL</Label>
          <Input
            id="jira-site"
            placeholder="https://your-company.atlassian.net"
            value={form.siteUrl}
            onChange={(e) => setForm((f) => ({ ...f, siteUrl: e.target.value }))}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="jira-email">Account email</Label>
          <Input
            id="jira-email"
            type="email"
            value={form.email}
            onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="jira-token">API token</Label>
          <Input
            id="jira-token"
            type="password"
            placeholder={hasToken ? "•••••••• (stored — leave blank to keep)" : "Jira API token"}
            value={form.apiToken}
            onChange={(e) => setForm((f) => ({ ...f, apiToken: e.target.value }))}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="jira-jql">JQL</Label>
          <Textarea
            id="jira-jql"
            rows={2}
            value={form.jql}
            onChange={(e) => setForm((f) => ({ ...f, jql: e.target.value }))}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="jira-interval">Auto-sync interval (minutes, 0 = off)</Label>
          <Input
            id="jira-interval"
            type="number"
            min={0}
            value={form.pollIntervalMinutes}
            onChange={(e) =>
              setForm((f) => ({ ...f, pollIntervalMinutes: Number(e.target.value) || 0 }))
            }
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="jira-status-map">Status mapping overrides (JSON)</Label>
          <Textarea
            id="jira-status-map"
            rows={4}
            placeholder='{"in qa": "in_review"}'
            value={form.statusMappingText}
            onChange={(e) => setForm((f) => ({ ...f, statusMappingText: e.target.value }))}
          />
          <p className="text-xs text-muted-foreground">
            Lowercased Jira status name → Multica status (backlog, todo, in_progress, in_review,
            done, blocked, cancelled). Unmapped statuses default to backlog.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={() => void onSave()}>
            Save
          </Button>
          <Button onClick={() => void syncNow()} disabled={running}>
            {running ? "Syncing…" : "Sync now"}
          </Button>
        </div>

        {saveMessage && <p className="text-sm text-muted-foreground">{saveMessage}</p>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        {lastResult && (
          <p className="text-sm text-muted-foreground">
            Last sync: {lastResult.created} created, {lastResult.updated} updated,{" "}
            {lastResult.commentsAdded} comments
            {lastResult.errors.length > 0 ? `, ${lastResult.errors.length} errors` : ""}.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
