import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { ipcMain, net, type WebContents } from "electron";

/** Channel the main process uses to ask the renderer to run a sync. The actual
 *  sync executes in the renderer because it needs the workspace ApiClient. */
export const JIRA_POLL_TICK_CHANNEL = "jira:poll-tick";

/** Token-bearing config persisted in the main process only. The renderer can
 *  read/write the non-secret fields via IPC but never sees the token — Jira
 *  requests are issued here. Mirrors daemon-manager's ~/.multica/*.json prefs. */
export interface JiraStoredConfig {
  siteUrl: string;
  email: string;
  apiToken: string;
  jql: string;
  statusMapping: Record<string, string>;
  pollIntervalMinutes: number;
}

const DEFAULT_CONFIG: JiraStoredConfig = {
  siteUrl: "",
  email: "",
  apiToken: "",
  jql: "assignee = currentUser() ORDER BY updated DESC",
  statusMapping: {},
  pollIntervalMinutes: 0,
};

export function jiraConfigPath(): string {
  return join(homedir(), ".multica", "jira.json");
}

export function buildJiraRequestInit(
  creds: { siteUrl: string; email: string; apiToken: string },
  req: { method: string; path: string },
): { url: string; method: string; headers: Record<string, string> } {
  const base = creds.siteUrl.replace(/\/+$/, "");
  return {
    url: `${base}${req.path}`,
    method: req.method,
    headers: {
      Authorization: "Basic " + Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64"),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  };
}

/** Convert a poll interval in minutes to milliseconds, with a 1-minute floor.
 *  Returns 0 when polling is disabled. */
export function computePollDelayMs(minutes: number): number {
  if (!minutes || minutes <= 0) return 0;
  return Math.max(1, minutes) * 60 * 1000;
}

async function loadConfig(): Promise<JiraStoredConfig> {
  try {
    const raw = await readFile(jiraConfigPath(), "utf-8");
    return { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<JiraStoredConfig>) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function saveConfig(patch: Partial<JiraStoredConfig>): Promise<JiraStoredConfig> {
  const merged = { ...(await loadConfig()), ...patch };
  await mkdir(join(homedir(), ".multica"), { recursive: true });
  await writeFile(jiraConfigPath(), JSON.stringify(merged, null, 2), "utf-8");
  return merged;
}

/** Non-secret view sent to the renderer (token redacted to a boolean). */
function redact(c: JiraStoredConfig) {
  return { ...c, apiToken: "", hasToken: c.apiToken.length > 0 };
}

export function registerJiraHandlers(): void {
  ipcMain.handle("jira:get-config", async () => redact(await loadConfig()));

  ipcMain.handle("jira:set-config", async (_e, patch: Partial<JiraStoredConfig>) => {
    // Empty-string apiToken from the renderer means "leave unchanged".
    if (patch.apiToken === "") delete patch.apiToken;
    return redact(await saveConfig(patch));
  });

  ipcMain.handle(
    "jira:request",
    async (_e, req: { method: string; path: string; body?: unknown }) => {
      const c = await loadConfig();
      const init = buildJiraRequestInit(c, req);
      const res = await net.fetch(init.url, {
        method: init.method,
        headers: init.headers,
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      });
      if (!res.ok) throw new Error(`Jira ${res.status}: ${await res.text()}`);
      return res.json();
    },
  );
}

/** Start (or restart) the poll timer. Reads the configured interval and, when
 *  enabled, periodically signals the renderer to run a sync. Returns a stop fn. */
export async function startJiraPolling(
  getWebContents: () => WebContents | null,
): Promise<() => void> {
  const c = await loadConfig();
  const delay = computePollDelayMs(c.pollIntervalMinutes);
  if (delay === 0) return () => {};
  const timer = setInterval(() => {
    getWebContents()?.send(JIRA_POLL_TICK_CHANNEL);
  }, delay);
  return () => clearInterval(timer);
}
