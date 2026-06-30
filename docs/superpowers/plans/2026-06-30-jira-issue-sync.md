# Jira → Multica 单向 Issue 同步 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Multica 桌面客户端实现「分配给我」的 Jira issue（含评论、子任务）单向同步进 Multica，零 Go server 改动。

**Architecture:** Jira REST 请求在 Electron 主进程发起以绕过 CORS，通过 IPC 暴露给渲染层；纯同步引擎在 `packages/core/jira/`，靠 issue `metadata` KV 存 `jira_key` 去重；UI 在 `packages/views/settings/jira/`，复用现有 `createIssue`/`updateIssue`/`createComment` + 新增 metadata 写 API。

**Tech Stack:** TypeScript（strict）、zod + `parseWithFallback`、Vitest、Electron `net` + `ipcMain`/`contextBridge`、React。

设计来源：`docs/superpowers/specs/2026-06-30-jira-issue-sync-design.md`

---

## File Structure

纯逻辑核心（可单测，本计划重点）：

- `packages/core/jira/metadata-keys.ts` — 6 个 metadata 键常量。
- `packages/core/jira/types.ts` — Jira REST zod schema + 解析类型、`JiraConfig`、`JiraTransport`、`SyncResult`。
- `packages/core/jira/adf.ts` — Jira ADF → 纯文本/Markdown。
- `packages/core/jira/mapping.ts` — 默认状态/优先级映射表 + 覆盖合并 + 字段映射。
- `packages/core/jira/sync-engine.ts` — 同步编排：去重、创建/更新/跳过、子任务、评论增量。
- `packages/core/jira/index.ts` — 桶导出。

客户端 API：

- `packages/core/api/client.ts` — 新增 `getIssueMetadata` / `setIssueMetadata`。

桌面集成层：

- `apps/desktop/src/main/jira.ts` — `jira:request` / `jira:get-config` / `jira:set-config` IPC + `~/.multica/jira.json` 读写 + `net` 请求。
- `apps/desktop/src/preload/index.ts` + `index.d.ts` — 暴露 `window.jiraAPI`。
- `apps/desktop/src/main/index.ts` — 注册 handler + 轮询定时器。

UI：

- `packages/views/settings/jira/jira-settings.tsx` — 连接配置 + 映射编辑 + 立即同步 + 结果展示。
- `packages/views/issues/` 列表组件 — 来源徽标 + 筛选（落点在实现时按现有结构定位）。

---

## Task 1: metadata 键常量

**Files:**
- Create: `packages/core/jira/metadata-keys.ts`
- Test: `packages/core/jira/metadata-keys.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { JIRA_METADATA_KEYS } from "./metadata-keys";

describe("JIRA_METADATA_KEYS", () => {
  it("exposes the six sync keys with valid metadata key names", () => {
    const re = /^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/;
    const values = Object.values(JIRA_METADATA_KEYS);
    expect(values).toEqual([
      "source",
      "jira_key",
      "jira_url",
      "jira_status",
      "jira_updated_at",
      "jira_comments_synced_at",
    ]);
    for (const v of values) expect(v).toMatch(re);
  });

  it("marks jira-sourced issues with the literal source value", () => {
    expect(JIRA_METADATA_KEYS.source).toBe("source");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @multica/core test -- metadata-keys`
Expected: FAIL — `Cannot find module './metadata-keys'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/jira/metadata-keys.ts

/** The literal value stored under the `source` metadata key for issues that
 *  originated from a Jira sync. Lets the UI distinguish Jira issues from
 *  user-created ones without any server-side schema change. */
export const JIRA_SOURCE_VALUE = "jira" as const;

/** Per-issue metadata keys used by the Jira sync. All values are primitive
 *  strings (the issue metadata API only accepts string/number/bool). */
export const JIRA_METADATA_KEYS = {
  source: "source",
  jiraKey: "jira_key",
  jiraUrl: "jira_url",
  jiraStatus: "jira_status",
  jiraUpdatedAt: "jira_updated_at",
  jiraCommentsSyncedAt: "jira_comments_synced_at",
} as const;
```

Note: the test asserts `Object.values` order matches the declaration order above.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @multica/core test -- metadata-keys`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/jira/metadata-keys.ts packages/core/jira/metadata-keys.test.ts
git commit -m "feat(jira): add issue metadata key constants for sync"
```

---

## Task 2: Jira REST zod schemas + core types

**Files:**
- Create: `packages/core/jira/types.ts`
- Test: `packages/core/jira/types.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { JiraSearchResponseSchema, parseJiraSearch } from "./types";

const RAW = {
  issues: [
    {
      key: "PROJ-1",
      fields: {
        summary: "Fix login",
        description: null,
        duedate: "2026-07-01",
        updated: "2026-06-30T10:00:00.000+0000",
        status: { name: "In Progress" },
        priority: { name: "High" },
        subtasks: [{ key: "PROJ-2" }],
        comment: { comments: [] },
      },
    },
  ],
  total: 1,
};

describe("parseJiraSearch", () => {
  it("parses a well-formed search response", () => {
    const res = parseJiraSearch(RAW);
    expect(res.issues[0].key).toBe("PROJ-1");
    expect(res.issues[0].fields.status.name).toBe("In Progress");
    expect(res.issues[0].fields.subtasks[0].key).toBe("PROJ-2");
  });

  it("falls back to an empty result on malformed input", () => {
    const res = parseJiraSearch({ issues: "nope" });
    expect(res).toEqual({ issues: [], total: 0 });
  });

  it("defaults optional/nullable fields without throwing", () => {
    const res = parseJiraSearch({
      issues: [{ key: "PROJ-3", fields: { summary: "x", status: { name: "Done" } } }],
      total: 1,
    });
    expect(res.issues[0].fields.priority).toBeNull();
    expect(res.issues[0].fields.subtasks).toEqual([]);
    expect(res.issues[0].fields.comment.comments).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @multica/core test -- jira/types`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/jira/types.ts
import { z } from "zod";
import type { ApiClient } from "../api/client";
import type { IssueStatus } from "../types/api";

/** Jira ADF (Atlassian Document Format) is a recursive node tree. We keep the
 *  schema permissive (passthrough) — adf.ts walks it for text, and we never
 *  re-serialize it, so unknown node types degrade gracefully. */
export const AdfNodeSchema: z.ZodType<unknown> = z.any();

export const JiraCommentSchema = z.object({
  id: z.string(),
  created: z.string(),
  body: z.unknown().optional(),
  author: z.object({ displayName: z.string().optional() }).partial().optional(),
});
export type JiraComment = z.infer<typeof JiraCommentSchema>;

export const JiraIssueFieldsSchema = z.object({
  summary: z.string().default(""),
  description: z.unknown().nullable().default(null),
  duedate: z.string().nullable().default(null),
  updated: z.string().default(""),
  status: z.object({ name: z.string().default("") }).default({ name: "" }),
  priority: z.object({ name: z.string() }).nullable().default(null),
  subtasks: z.array(z.object({ key: z.string() })).default([]),
  comment: z
    .object({ comments: z.array(JiraCommentSchema).default([]) })
    .default({ comments: [] }),
});

export const JiraIssueSchema = z.object({
  key: z.string(),
  fields: JiraIssueFieldsSchema,
});
export type JiraIssue = z.infer<typeof JiraIssueSchema>;

export const JiraSearchResponseSchema = z.object({
  issues: z.array(JiraIssueSchema).default([]),
  total: z.number().default(0),
});
export type JiraSearchResponse = z.infer<typeof JiraSearchResponseSchema>;

const EMPTY_SEARCH: JiraSearchResponse = { issues: [], total: 0 };

/** Parse a Jira /search response, degrading to an empty result on any shape
 *  mismatch — mirrors the repo's parseWithFallback discipline for network JSON. */
export function parseJiraSearch(raw: unknown): JiraSearchResponse {
  const parsed = JiraSearchResponseSchema.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_SEARCH;
}

/** Single-issue fetch (used for subtasks), same fallback discipline. */
export function parseJiraIssue(raw: unknown): JiraIssue | null {
  const parsed = JiraIssueSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Transport injected into the sync engine. In the desktop app this is backed
 *  by the main-process `jira:request` IPC channel; tests pass a fake. */
export type JiraTransport = (req: {
  method: string;
  path: string;
  body?: unknown;
}) => Promise<unknown>;

export interface JiraConfig {
  /** e.g. https://acme.atlassian.net (no trailing slash) */
  siteUrl: string;
  email: string;
  /** JQL filter; default targets the token owner. */
  jql: string;
  /** Override map: lowercased Jira status name -> Multica status. */
  statusMapping: Record<string, IssueStatus>;
  /** 0 disables auto-polling. */
  pollIntervalMinutes: number;
}

export interface SyncResult {
  created: number;
  updated: number;
  skipped: number;
  commentsAdded: number;
  errors: { jiraKey: string; message: string }[];
}

export interface SyncDeps {
  transport: JiraTransport;
  api: ApiClient;
  config: JiraConfig;
  /** Multica member the synced issues are created/assigned as. */
  currentMemberId: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @multica/core test -- jira/types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/jira/types.ts packages/core/jira/types.test.ts
git commit -m "feat(jira): add Jira REST zod schemas and core sync types"
```

---

## Task 3: ADF → 纯文本转换

**Files:**
- Create: `packages/core/jira/adf.ts`
- Test: `packages/core/jira/adf.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { adfToText } from "./adf";

describe("adfToText", () => {
  it("returns a plain string unchanged", () => {
    expect(adfToText("hello")).toBe("hello");
  });

  it("returns empty string for null/undefined", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText(undefined)).toBe("");
  });

  it("extracts text from a paragraph doc", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Line one" }] },
        { type: "paragraph", content: [{ type: "text", text: "Line two" }] },
      ],
    };
    expect(adfToText(doc)).toBe("Line one\n\nLine two");
  });

  it("renders bullet list items", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
            { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toBe("- a\n- b");
  });

  it("ignores unknown node types but keeps their text children", () => {
    const doc = { type: "doc", content: [{ type: "weird", content: [{ type: "text", text: "kept" }] }] };
    expect(adfToText(doc)).toBe("kept");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @multica/core test -- jira/adf`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/jira/adf.ts

/** Convert a Jira description/comment body to plain text. Jira Cloud bodies are
 *  ADF node trees; older payloads may already be strings. We extract readable
 *  text rather than full Markdown fidelity — enough for a synced description.
 *  Unknown node types are walked for their text children, never dropped. */
export function adfToText(body: unknown): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  if (typeof body !== "object") return "";
  return renderBlocks(asNode(body).content).trim();
}

interface AdfNode {
  type?: string;
  text?: string;
  content?: unknown[];
}

function asNode(value: unknown): AdfNode {
  return (value ?? {}) as AdfNode;
}

function renderBlocks(content: unknown[] | undefined): string {
  if (!Array.isArray(content)) return "";
  const blocks: string[] = [];
  for (const raw of content) {
    const node = asNode(raw);
    switch (node.type) {
      case "paragraph":
      case "heading":
        blocks.push(renderInline(node.content));
        break;
      case "bulletList":
      case "orderedList":
        blocks.push(renderList(node.content));
        break;
      case "text":
        blocks.push(node.text ?? "");
        break;
      default:
        // Unknown block: keep its text by recursing into children.
        blocks.push(renderBlocks(node.content));
    }
  }
  return blocks.filter((b) => b.length > 0).join("\n\n");
}

function renderList(items: unknown[] | undefined): string {
  if (!Array.isArray(items)) return "";
  return items
    .map((raw) => `- ${renderBlocks(asNode(raw).content).replace(/\n+/g, " ").trim()}`)
    .join("\n");
}

function renderInline(content: unknown[] | undefined): string {
  if (!Array.isArray(content)) return "";
  return content.map((raw) => asNode(raw).text ?? "").join("");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @multica/core test -- jira/adf`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/jira/adf.ts packages/core/jira/adf.test.ts
git commit -m "feat(jira): convert ADF bodies to plain text"
```

---

## Task 4: 状态/优先级/字段映射

**Files:**
- Create: `packages/core/jira/mapping.ts`
- Test: `packages/core/jira/mapping.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { mapStatus, mapPriority, jiraIssueToCreateRequest, jiraIssueToUpdateRequest } from "./mapping";
import type { JiraIssue } from "./types";

const issue: JiraIssue = {
  key: "PROJ-1",
  fields: {
    summary: "Fix login",
    description: "broken",
    duedate: "2026-07-01",
    updated: "2026-06-30T10:00:00.000+0000",
    status: { name: "In Progress" },
    priority: { name: "High" },
    subtasks: [],
    comment: { comments: [] },
  },
};

describe("mapStatus", () => {
  it("uses the built-in default map case-insensitively", () => {
    expect(mapStatus("In Progress", {})).toBe("in_progress");
    expect(mapStatus("done", {})).toBe("done");
  });
  it("prefers the user override over the default", () => {
    expect(mapStatus("In Progress", { "in progress": "in_review" })).toBe("in_review");
  });
  it("falls back to backlog for unknown statuses", () => {
    expect(mapStatus("Waiting for customer", {})).toBe("backlog");
  });
});

describe("mapPriority", () => {
  it("maps known Jira priorities", () => {
    expect(mapPriority("Highest")).toBe("urgent");
    expect(mapPriority("High")).toBe("high");
    expect(mapPriority(null)).toBe("none");
  });
});

describe("jiraIssueToCreateRequest", () => {
  it("maps core fields and assigns to the current member", () => {
    const req = jiraIssueToCreateRequest(issue, {}, "member-123");
    expect(req.title).toBe("Fix login");
    expect(req.description).toBe("broken");
    expect(req.status).toBe("in_progress");
    expect(req.priority).toBe("high");
    expect(req.due_date).toBe("2026-07-01");
    expect(req.assignee_type).toBe("member");
    expect(req.assignee_id).toBe("member-123");
  });
});

describe("jiraIssueToUpdateRequest", () => {
  it("maps only the Jira-authoritative fields", () => {
    const req = jiraIssueToUpdateRequest(issue, {});
    expect(req).toEqual({
      title: "Fix login",
      description: "broken",
      status: "in_progress",
      priority: "high",
      due_date: "2026-07-01",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @multica/core test -- jira/mapping`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/jira/mapping.ts
import type { CreateIssueRequest, UpdateIssueRequest, IssueStatus, IssuePriority } from "../types/api";
import { adfToText } from "./adf";
import type { JiraIssue } from "./types";

/** Built-in Jira-status (lowercased) -> Multica status. Unmatched -> backlog.
 *  User overrides (also lowercased keys) take precedence in mapStatus. */
const DEFAULT_STATUS_MAP: Record<string, IssueStatus> = {
  backlog: "backlog",
  "to do": "todo",
  open: "todo",
  "in progress": "in_progress",
  "in review": "in_review",
  done: "done",
  closed: "done",
  resolved: "done",
};

const DEFAULT_PRIORITY_MAP: Record<string, IssuePriority> = {
  highest: "urgent",
  high: "high",
  medium: "medium",
  low: "low",
  lowest: "low",
};

export function mapStatus(jiraStatus: string, overrides: Record<string, IssueStatus>): IssueStatus {
  const key = jiraStatus.trim().toLowerCase();
  return overrides[key] ?? DEFAULT_STATUS_MAP[key] ?? "backlog";
}

export function mapPriority(jiraPriority: string | null | undefined): IssuePriority {
  if (!jiraPriority) return "none";
  return DEFAULT_PRIORITY_MAP[jiraPriority.trim().toLowerCase()] ?? "none";
}

export function jiraIssueToCreateRequest(
  issue: JiraIssue,
  statusOverrides: Record<string, IssueStatus>,
  currentMemberId: string,
): CreateIssueRequest {
  const f = issue.fields;
  return {
    title: f.summary,
    description: adfToText(f.description),
    status: mapStatus(f.status.name, statusOverrides),
    priority: mapPriority(f.priority?.name),
    ...(f.duedate ? { due_date: f.duedate } : {}),
    assignee_type: "member",
    assignee_id: currentMemberId,
  };
}

export function jiraIssueToUpdateRequest(
  issue: JiraIssue,
  statusOverrides: Record<string, IssueStatus>,
): UpdateIssueRequest {
  const f = issue.fields;
  return {
    title: f.summary,
    description: adfToText(f.description),
    status: mapStatus(f.status.name, statusOverrides),
    priority: mapPriority(f.priority?.name),
    due_date: f.duedate ?? null,
  };
}
```

Note: the update test expects no `due_date` key only when null — here `duedate` is set, so `due_date: "2026-07-01"`. The `toEqual` in the test includes it; matches.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @multica/core test -- jira/mapping`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/jira/mapping.ts packages/core/jira/mapping.test.ts
git commit -m "feat(jira): map Jira fields/status/priority to Multica issue requests"
```

---

## Task 5: 客户端 metadata 读写 API

**Files:**
- Modify: `packages/core/api/client.ts` (add two methods near the existing issue methods, ~line 660)
- Test: `packages/core/api/client.test.ts` (append cases)

- [ ] **Step 1: Write the failing test**

Append to `packages/core/api/client.test.ts` (follow the file's existing fetch-stub harness; adjust the stub helper name to whatever the file already uses):

```ts
describe("issue metadata", () => {
  it("PUTs a single metadata key", async () => {
    const { client, calls } = makeClient(); // use the file's existing factory
    await client.setIssueMetadata("issue-1", "jira_key", "PROJ-1");
    expect(calls[0]).toMatchObject({
      url: expect.stringContaining("/api/issues/issue-1/metadata/jira_key"),
      method: "PUT",
      body: JSON.stringify({ value: "PROJ-1" }),
    });
  });

  it("GETs the metadata map", async () => {
    const { client } = makeClient({ jira_key: "PROJ-1" });
    const md = await client.getIssueMetadata("issue-1");
    expect(md.jira_key).toBe("PROJ-1");
  });
});
```

If the test file has no reusable factory, mirror the closest existing test's setup verbatim.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @multica/core test -- api/client`
Expected: FAIL — `client.setIssueMetadata is not a function`.

- [ ] **Step 3: Write minimal implementation**

Insert into `packages/core/api/client.ts` after `batchDeleteIssues` (around line 670), before the `// Comments` section:

```ts
  async getIssueMetadata(issueId: string): Promise<Record<string, string | number | boolean>> {
    const raw = await this.fetch<unknown>(`/api/issues/${issueId}/metadata`);
    const md = (raw as { metadata?: Record<string, string | number | boolean> })?.metadata;
    return md && typeof md === "object" ? md : {};
  }

  async setIssueMetadata(
    issueId: string,
    key: string,
    value: string | number | boolean,
  ): Promise<void> {
    await this.fetch(`/api/issues/${issueId}/metadata/${encodeURIComponent(key)}`, {
      method: "PUT",
      body: JSON.stringify({ value }),
    });
  }
```

Note: confirm the metadata GET response shape against `server/internal/handler/issue_metadata.go` before finalizing — if the handler returns the bare map (not `{ metadata }`), drop the `.metadata` unwrap. The PUT body `{ "value": ... }` matches `SetIssueMetadataKeyRequest`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @multica/core test -- api/client`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/api/client.ts packages/core/api/client.test.ts
git commit -m "feat(core): add issue metadata get/set client methods"
```

---

## Task 6: 同步引擎 — 去重与创建

**Files:**
- Create: `packages/core/jira/sync-engine.ts`
- Test: `packages/core/jira/sync-engine.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { syncJiraIssues } from "./sync-engine";
import type { JiraConfig } from "./types";

const config: JiraConfig = {
  siteUrl: "https://acme.atlassian.net",
  email: "me@acme.com",
  jql: "assignee = currentUser()",
  statusMapping: {},
  pollIntervalMinutes: 0,
};

function fakeApi(existing: any[] = []) {
  return {
    listIssues: vi.fn().mockResolvedValue({ issues: existing, total: existing.length }),
    createIssue: vi.fn(async (req: any) => ({ id: "new-" + req.title, ...req, metadata: {} })),
    updateIssue: vi.fn(async (id: string, req: any) => ({ id, ...req })),
    setIssueMetadata: vi.fn().mockResolvedValue(undefined),
    listComments: vi.fn().mockResolvedValue([]),
    createComment: vi.fn().mockResolvedValue({ id: "c1" }),
  } as any;
}

function searchResponse(issues: any[]) {
  return { issues, total: issues.length };
}

describe("syncJiraIssues — create", () => {
  it("creates a Multica issue for an unseen Jira issue and stamps metadata", async () => {
    const api = fakeApi([]);
    const transport = vi.fn(async ({ path }: any) =>
      path.includes("/search")
        ? searchResponse([
            {
              key: "PROJ-1",
              fields: {
                summary: "Fix login",
                description: null,
                duedate: null,
                updated: "2026-06-30T10:00:00.000+0000",
                status: { name: "To Do" },
                priority: null,
                subtasks: [],
                comment: { comments: [] },
              },
            },
          ])
        : {},
    );

    const result = await syncJiraIssues({ transport, api, config, currentMemberId: "m1" });

    expect(api.createIssue).toHaveBeenCalledTimes(1);
    expect(api.createIssue.mock.calls[0][0].title).toBe("Fix login");
    // 6 metadata keys written on create.
    const keysWritten = api.setIssueMetadata.mock.calls.map((c: any[]) => c[1]);
    expect(keysWritten).toEqual([
      "source",
      "jira_key",
      "jira_url",
      "jira_status",
      "jira_updated_at",
      "jira_comments_synced_at",
    ]);
    expect(result.created).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("skips an already-synced unchanged Jira issue", async () => {
    const api = fakeApi([
      {
        id: "i1",
        title: "Fix login",
        metadata: {
          source: "jira",
          jira_key: "PROJ-1",
          jira_updated_at: "2026-06-30T10:00:00.000+0000",
          jira_comments_synced_at: "2026-06-30T10:00:00.000+0000",
        },
      },
    ]);
    const transport = vi.fn(async ({ path }: any) =>
      path.includes("/search")
        ? searchResponse([
            {
              key: "PROJ-1",
              fields: {
                summary: "Fix login",
                description: null,
                duedate: null,
                updated: "2026-06-30T10:00:00.000+0000",
                status: { name: "To Do" },
                priority: null,
                subtasks: [],
                comment: { comments: [] },
              },
            },
          ])
        : {},
    );

    const result = await syncJiraIssues({ transport, api, config, currentMemberId: "m1" });
    expect(api.createIssue).not.toHaveBeenCalled();
    expect(api.updateIssue).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it("collects an error per failed issue without aborting the run", async () => {
    const api = fakeApi([]);
    api.createIssue.mockRejectedValueOnce(new Error("boom"));
    const transport = vi.fn(async ({ path }: any) =>
      path.includes("/search")
        ? searchResponse([
            { key: "PROJ-1", fields: { summary: "a", status: { name: "Done" }, subtasks: [], comment: { comments: [] }, updated: "t", description: null, duedate: null, priority: null } },
          ])
        : {},
    );
    const result = await syncJiraIssues({ transport, api, config, currentMemberId: "m1" });
    expect(result.errors).toEqual([{ jiraKey: "PROJ-1", message: "boom" }]);
    expect(result.created).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @multica/core test -- jira/sync-engine`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/core/jira/sync-engine.ts
import { JIRA_METADATA_KEYS, JIRA_SOURCE_VALUE } from "./metadata-keys";
import { jiraIssueToCreateRequest, jiraIssueToUpdateRequest } from "./mapping";
import { parseJiraSearch, parseJiraIssue } from "./types";
import type { JiraIssue, SyncDeps, SyncResult } from "./types";

interface ExistingRef {
  issueId: string;
  jiraUpdatedAt: string;
  commentsSyncedAt: string;
}

/** Pull Jira issues matching the configured JQL into Multica. One-way:
 *  create unseen issues, update changed ones (Jira authoritative), skip
 *  unchanged. Dedup is by the `jira_key` metadata key on existing issues. */
export async function syncJiraIssues(deps: SyncDeps): Promise<SyncResult> {
  const { transport, api, config, currentMemberId } = deps;
  const result: SyncResult = { created: 0, updated: 0, skipped: 0, commentsAdded: 0, errors: [] };

  const index = await buildJiraKeyIndex(api);

  const search = parseJiraSearch(
    await transport({ method: "GET", path: searchPath(config.jql) }),
  );

  for (const issue of search.issues) {
    try {
      await syncOne(deps, issue, index, null, result);
    } catch (err) {
      result.errors.push({ jiraKey: issue.key, message: errMessage(err) });
    }
  }
  return result;
}

async function syncOne(
  deps: SyncDeps,
  issue: JiraIssue,
  index: Map<string, ExistingRef>,
  parentIssueId: string | null,
  result: SyncResult,
): Promise<string> {
  const { api, config, currentMemberId } = deps;
  const existing = index.get(issue.key);
  let issueId: string;

  if (!existing) {
    const req = jiraIssueToCreateRequest(issue, config.statusMapping, currentMemberId);
    if (parentIssueId) req.parent_issue_id = parentIssueId;
    const created = await api.createIssue(req);
    issueId = created.id;
    await stampMetadata(deps, issueId, issue, issue.fields.updated);
    index.set(issue.key, {
      issueId,
      jiraUpdatedAt: issue.fields.updated,
      commentsSyncedAt: issue.fields.updated,
    });
    result.created += 1;
  } else {
    issueId = existing.issueId;
    if (issue.fields.updated > existing.jiraUpdatedAt) {
      await api.updateIssue(issueId, jiraIssueToUpdateRequest(issue, config.statusMapping));
      await api.setIssueMetadata(issueId, JIRA_METADATA_KEYS.jiraStatus, issue.fields.status.name);
      await api.setIssueMetadata(issueId, JIRA_METADATA_KEYS.jiraUpdatedAt, issue.fields.updated);
      result.updated += 1;
    } else {
      result.skipped += 1;
    }
  }
  return issueId;
}

async function buildJiraKeyIndex(api: SyncDeps["api"]): Promise<Map<string, ExistingRef>> {
  const index = new Map<string, ExistingRef>();
  const { issues } = await api.listIssues({});
  for (const i of issues) {
    const md = (i as { metadata?: Record<string, unknown> }).metadata ?? {};
    const key = md[JIRA_METADATA_KEYS.jiraKey];
    if (typeof key === "string" && key) {
      index.set(key, {
        issueId: i.id,
        jiraUpdatedAt: String(md[JIRA_METADATA_KEYS.jiraUpdatedAt] ?? ""),
        commentsSyncedAt: String(md[JIRA_METADATA_KEYS.jiraCommentsSyncedAt] ?? ""),
      });
    }
  }
  return index;
}

async function stampMetadata(
  deps: SyncDeps,
  issueId: string,
  issue: JiraIssue,
  commentsHighWater: string,
): Promise<void> {
  const { api, config } = deps;
  await api.setIssueMetadata(issueId, JIRA_METADATA_KEYS.source, JIRA_SOURCE_VALUE);
  await api.setIssueMetadata(issueId, JIRA_METADATA_KEYS.jiraKey, issue.key);
  await api.setIssueMetadata(issueId, JIRA_METADATA_KEYS.jiraUrl, `${config.siteUrl}/browse/${issue.key}`);
  await api.setIssueMetadata(issueId, JIRA_METADATA_KEYS.jiraStatus, issue.fields.status.name);
  await api.setIssueMetadata(issueId, JIRA_METADATA_KEYS.jiraUpdatedAt, issue.fields.updated);
  await api.setIssueMetadata(issueId, JIRA_METADATA_KEYS.jiraCommentsSyncedAt, commentsHighWater);
}

function searchPath(jql: string): string {
  return `/rest/api/3/search?jql=${encodeURIComponent(jql)}&fields=summary,description,status,priority,duedate,updated,subtasks,comment&maxResults=100`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

Note: `api.listIssues({})` — confirm the actual signature/param object in `client.ts` (the codebase has `listIssues` with a params object) and match it; the test's `fakeApi` mocks it as a no-arg-tolerant fn.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @multica/core test -- jira/sync-engine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/jira/sync-engine.ts packages/core/jira/sync-engine.test.ts
git commit -m "feat(jira): sync engine create/update/skip with metadata dedup"
```

---

## Task 7: 同步引擎 — 子任务与评论增量

**Files:**
- Modify: `packages/core/jira/sync-engine.ts`
- Test: `packages/core/jira/sync-engine.test.ts` (append)

- [ ] **Step 1: Write the failing test**

```ts
describe("syncJiraIssues — subtasks and comments", () => {
  it("creates subtasks as Multica child issues under their parent", async () => {
    const api = fakeApi([]);
    const transport = vi.fn(async ({ path }: any) => {
      if (path.includes("/search")) {
        return searchResponse([
          {
            key: "PROJ-1",
            fields: {
              summary: "Parent", description: null, duedate: null,
              updated: "2026-06-30T10:00:00.000+0000",
              status: { name: "To Do" }, priority: null,
              subtasks: [{ key: "PROJ-2" }], comment: { comments: [] },
            },
          },
        ]);
      }
      if (path.includes("/issue/PROJ-2")) {
        return {
          key: "PROJ-2",
          fields: {
            summary: "Child", description: null, duedate: null,
            updated: "2026-06-30T09:00:00.000+0000",
            status: { name: "Done" }, priority: null,
            subtasks: [], comment: { comments: [] },
          },
        };
      }
      return {};
    });

    const result = await syncJiraIssues({ transport, api, config, currentMemberId: "m1" });
    expect(result.created).toBe(2);
    const childReq = api.createIssue.mock.calls.find((c: any[]) => c[0].title === "Child")[0];
    expect(childReq.parent_issue_id).toBe("new-Parent");
  });

  it("adds only Jira comments newer than the high-water mark", async () => {
    const api = fakeApi([]);
    const transport = vi.fn(async ({ path }: any) =>
      path.includes("/search")
        ? searchResponse([
            {
              key: "PROJ-1",
              fields: {
                summary: "Parent", description: null, duedate: null,
                updated: "2026-06-30T10:00:00.000+0000",
                status: { name: "To Do" }, priority: null, subtasks: [],
                comment: {
                  comments: [
                    { id: "c1", created: "2026-06-30T08:00:00.000+0000", body: "old" },
                    { id: "c2", created: "2026-06-30T11:00:00.000+0000", body: "new" },
                  ],
                },
              },
            },
          ])
        : {},
    );

    const result = await syncJiraIssues({ transport, api, config, currentMemberId: "m1" });
    // On a freshly-created issue the high-water mark = issue.updated (10:00),
    // so only c2 (11:00) is newer.
    expect(api.createComment).toHaveBeenCalledTimes(1);
    expect(api.createComment.mock.calls[0][1]).toContain("new");
    expect(result.commentsAdded).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @multica/core test -- jira/sync-engine`
Expected: FAIL — subtasks not fetched / comments not synced.

- [ ] **Step 3: Write minimal implementation**

In `sync-engine.ts`, extend `syncOne` to handle comments and recurse into subtasks. Replace the `return issueId;` tail with comment + subtask handling and add helpers:

```ts
  // ...after computing issueId in syncOne, before returning:
  await syncComments(deps, issueId, issue, index, result);
  await syncSubtasks(deps, issue, issueId, index, result);
  return issueId;
}

async function syncComments(
  deps: SyncDeps,
  issueId: string,
  issue: JiraIssue,
  index: Map<string, ExistingRef>,
  result: SyncResult,
): Promise<void> {
  const ref = index.get(issue.key);
  const highWater = ref?.commentsSyncedAt ?? "";
  let maxCreated = highWater;
  const fresh = issue.fields.comment.comments.filter((c) => c.created > highWater);
  for (const c of fresh) {
    const author = c.author?.displayName ? `**${c.author.displayName}** (Jira):\n\n` : "";
    await deps.api.createComment(issueId, `${author}${adfBody(c.body)}`);
    result.commentsAdded += 1;
    if (c.created > maxCreated) maxCreated = c.created;
  }
  if (maxCreated !== highWater) {
    await deps.api.setIssueMetadata(issueId, JIRA_METADATA_KEYS.jiraCommentsSyncedAt, maxCreated);
    if (ref) ref.commentsSyncedAt = maxCreated;
  }
}

async function syncSubtasks(
  deps: SyncDeps,
  parent: JiraIssue,
  parentIssueId: string,
  index: Map<string, ExistingRef>,
  result: SyncResult,
): Promise<void> {
  for (const sub of parent.fields.subtasks) {
    try {
      const raw = await deps.transport({ method: "GET", path: issuePath(sub.key) });
      const child = parseJiraIssue(raw);
      if (child) await syncOne(deps, child, index, parentIssueId, result);
    } catch (err) {
      result.errors.push({ jiraKey: sub.key, message: errMessage(err) });
    }
  }
}

function issuePath(key: string): string {
  return `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,status,priority,duedate,updated,subtasks,comment`;
}
```

Add the import at the top of the file:

```ts
import { adfToText as adfBody } from "./adf";
```

Note: comment high-water for a freshly-created issue is set to `issue.fields.updated` in Task 6's `stampMetadata`, so the index ref's `commentsSyncedAt` is populated before `syncComments` runs — confirm ordering (stamp happens inside the `!existing` branch before comment sync). For correctness, ensure `stampMetadata` sets the index ref (it does in Task 6's `syncOne`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @multica/core test -- jira/sync-engine`
Expected: PASS (all sync-engine tests, Task 6 + Task 7).

- [ ] **Step 5: Commit**

```bash
git add packages/core/jira/sync-engine.ts packages/core/jira/sync-engine.test.ts
git commit -m "feat(jira): sync Jira subtasks as child issues and append new comments"
```

---

## Task 8: 桶导出

**Files:**
- Create: `packages/core/jira/index.ts`

- [ ] **Step 1: Write the export barrel**

```ts
// packages/core/jira/index.ts
export * from "./types";
export * from "./metadata-keys";
export * from "./mapping";
export { adfToText } from "./adf";
export { syncJiraIssues } from "./sync-engine";
```

- [ ] **Step 2: Verify typecheck**

Run: `pnpm --filter @multica/core typecheck`
Expected: PASS, no unresolved exports.

- [ ] **Step 3: Commit**

```bash
git add packages/core/jira/index.ts
git commit -m "chore(jira): add core jira module barrel export"
```

---

## Task 9: 桌面主进程 Jira IPC

**Files:**
- Create: `apps/desktop/src/main/jira.ts`
- Test: `apps/desktop/src/main/jira.test.ts`
- Modify: `apps/desktop/src/main/index.ts` (register handlers in the existing `ipcMain` setup block, ~line 416)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildJiraRequestInit, jiraConfigPath } from "./jira";

describe("buildJiraRequestInit", () => {
  it("builds a Basic-auth Jira request from config", () => {
    const init = buildJiraRequestInit(
      { siteUrl: "https://acme.atlassian.net", email: "me@acme.com", apiToken: "tok" },
      { method: "GET", path: "/rest/api/3/myself" },
    );
    expect(init.url).toBe("https://acme.atlassian.net/rest/api/3/myself");
    expect(init.headers.Authorization).toBe(
      "Basic " + Buffer.from("me@acme.com:tok").toString("base64"),
    );
    expect(init.headers.Accept).toBe("application/json");
  });

  it("strips a trailing slash from siteUrl", () => {
    const init = buildJiraRequestInit(
      { siteUrl: "https://acme.atlassian.net/", email: "e", apiToken: "t" },
      { method: "GET", path: "/rest/api/3/myself" },
    );
    expect(init.url).toBe("https://acme.atlassian.net/rest/api/3/myself");
  });
});

describe("jiraConfigPath", () => {
  it("points at ~/.multica/jira.json", () => {
    expect(jiraConfigPath()).toMatch(/\.multica[/\\]jira\.json$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @multica/desktop test -- main/jira` (match the desktop test runner; if it uses a different command, mirror `daemon-os.test.ts`'s invocation)
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/desktop/src/main/jira.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { ipcMain, net } from "electron";

/** Token-bearing config persisted in the main process only. The renderer can
 *  read/write the non-secret fields via IPC but never sees the token in a
 *  shape that would let it be exfiltrated to a remote — requests are issued
 *  here. Mirrors daemon-manager's ~/.multica/*.json prefs pattern. */
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

async function loadConfig(): Promise<JiraStoredConfig> {
  try {
    const raw = await readFile(jiraConfigPath(), "utf-8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
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
```

In `apps/desktop/src/main/index.ts`, inside the block where other `ipcMain.handle` calls are registered (near line 416), add:

```ts
    registerJiraHandlers();
```

and at the top of the file:

```ts
import { registerJiraHandlers } from "./jira";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @multica/desktop test -- main/jira`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/jira.ts apps/desktop/src/main/jira.test.ts apps/desktop/src/main/index.ts
git commit -m "feat(desktop): main-process Jira REST IPC bridge and config store"
```

---

## Task 10: preload 暴露 window.jiraAPI

**Files:**
- Modify: `apps/desktop/src/preload/index.ts` (add `jiraAPI` alongside `daemonAPI`, expose near line 307)
- Modify: `apps/desktop/src/preload/index.d.ts` (declare the global)

- [ ] **Step 1: Add the preload bridge**

In `apps/desktop/src/preload/index.ts`, define and expose:

```ts
const jiraAPI = {
  request: (req: { method: string; path: string; body?: unknown }) =>
    ipcRenderer.invoke("jira:request", req) as Promise<unknown>,
  getConfig: () => ipcRenderer.invoke("jira:get-config") as Promise<JiraRendererConfig>,
  setConfig: (patch: Partial<JiraRendererConfig>) =>
    ipcRenderer.invoke("jira:set-config", patch) as Promise<JiraRendererConfig>,
};
```

and where the other globals are assigned (around line 307):

```ts
  window.jiraAPI = jiraAPI;
```

If the file uses `contextBridge.exposeInMainWorld` instead of `window.*` assignment, mirror that exact mechanism (check how `daemonAPI` is exposed in the same file and copy it).

- [ ] **Step 2: Declare the global type**

In `apps/desktop/src/preload/index.d.ts`, add:

```ts
export interface JiraRendererConfig {
  siteUrl: string;
  email: string;
  apiToken: string; // always "" when read back; non-empty only when writing
  hasToken: boolean;
  jql: string;
  statusMapping: Record<string, string>;
  pollIntervalMinutes: number;
}

declare global {
  interface Window {
    jiraAPI: {
      request: (req: { method: string; path: string; body?: unknown }) => Promise<unknown>;
      getConfig: () => Promise<JiraRendererConfig>;
      setConfig: (patch: Partial<JiraRendererConfig>) => Promise<JiraRendererConfig>;
    };
  }
}
```

- [ ] **Step 3: Verify typecheck**

Run: `pnpm --filter @multica/desktop typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/preload/index.ts apps/desktop/src/preload/index.d.ts
git commit -m "feat(desktop): expose window.jiraAPI to the renderer"
```

---

## Task 11: 渲染层同步触发器（hook）

**Files:**
- Create: `packages/views/settings/jira/use-jira-sync.ts`
- Test: `packages/views/settings/jira/use-jira-sync.test.ts`

This hook adapts `window.jiraAPI.request` into a `JiraTransport` and runs `syncJiraIssues` against the workspace `ApiClient`. It is the seam the settings UI calls.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useJiraSync } from "./use-jira-sync";

vi.mock("@multica/core", async (orig) => {
  const mod = await orig<typeof import("@multica/core")>();
  return { ...mod, syncJiraIssues: vi.fn().mockResolvedValue({ created: 2, updated: 0, skipped: 0, commentsAdded: 0, errors: [] }) };
});

describe("useJiraSync", () => {
  beforeEach(() => {
    (globalThis as any).window.jiraAPI = {
      request: vi.fn().mockResolvedValue({}),
      getConfig: vi.fn().mockResolvedValue({
        siteUrl: "https://acme.atlassian.net", email: "me@acme.com", hasToken: true,
        jql: "assignee = currentUser()", statusMapping: {}, pollIntervalMinutes: 0, apiToken: "",
      }),
      setConfig: vi.fn(),
    };
  });

  it("runs a sync and returns the result", async () => {
    const { result } = renderHook(() => useJiraSync({ currentMemberId: "m1" }));
    let res: any;
    await act(async () => { res = await result.current.syncNow(); });
    expect(res.created).toBe(2);
    expect(result.current.lastResult?.created).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @multica/views test -- use-jira-sync`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/views/settings/jira/use-jira-sync.ts
import { useCallback, useState } from "react";
import { syncJiraIssues, type JiraConfig, type JiraTransport, type SyncResult } from "@multica/core";
import { useApiClient } from "@multica/core"; // adjust to the actual client accessor used in views

interface UseJiraSyncArgs {
  currentMemberId: string;
}

export function useJiraSync({ currentMemberId }: UseJiraSyncArgs) {
  const api = useApiClient(); // resolve the workspace ApiClient the way other views hooks do
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<SyncResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const syncNow = useCallback(async (): Promise<SyncResult | null> => {
    if (!window.jiraAPI) {
      setError("Jira sync is only available in the desktop app.");
      return null;
    }
    setRunning(true);
    setError(null);
    try {
      const cfg = await window.jiraAPI.getConfig();
      const transport: JiraTransport = (req) => window.jiraAPI.request(req);
      const config: JiraConfig = {
        siteUrl: cfg.siteUrl,
        email: cfg.email,
        jql: cfg.jql,
        statusMapping: cfg.statusMapping as JiraConfig["statusMapping"],
        pollIntervalMinutes: cfg.pollIntervalMinutes,
      };
      const result = await syncJiraIssues({ transport, api, config, currentMemberId });
      setLastResult(result);
      return result;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setRunning(false);
    }
  }, [api, currentMemberId]);

  return { syncNow, running, lastResult, error };
}
```

Note: `useApiClient` / client accessor — replace with whatever pattern `packages/views` already uses to reach the `ApiClient` (grep an existing mutation hook in views). The CLAUDE.md rule "only auth/workspace stores call api.* directly" is about Zustand stores; this hook performs an explicit user-triggered batch import, which is an acceptable imperative use, but prefer wrapping the client the same way existing views code does.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @multica/views test -- use-jira-sync`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/views/settings/jira/use-jira-sync.ts packages/views/settings/jira/use-jira-sync.test.ts
git commit -m "feat(views): useJiraSync hook bridging desktop transport to sync engine"
```

---

## Task 12: 设置页 UI

**Files:**
- Create: `packages/views/settings/jira/jira-settings.tsx`
- Test: `packages/views/settings/jira/jira-settings.test.tsx`
- Modify: settings navigation/registry (locate the existing settings route table, e.g. `packages/views/settings/` index, and add a "Jira" entry mirroring the Lark/Slack settings entry)

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { JiraSettings } from "./jira-settings";

vi.mock("./use-jira-sync", () => ({
  useJiraSync: () => ({
    syncNow: vi.fn().mockResolvedValue({ created: 3, updated: 1, skipped: 0, commentsAdded: 2, errors: [] }),
    running: false,
    lastResult: { created: 3, updated: 1, skipped: 0, commentsAdded: 2, errors: [] },
    error: null,
  }),
}));

describe("JiraSettings", () => {
  it("renders connection fields and a sync button", () => {
    render(<JiraSettings currentMemberId="m1" />);
    expect(screen.getByLabelText(/site/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sync/i })).toBeInTheDocument();
  });

  it("shows last sync counts", () => {
    render(<JiraSettings currentMemberId="m1" />);
    expect(screen.getByText(/3/)).toBeInTheDocument(); // created count
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @multica/views test -- jira-settings`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Build the form with the repo's shadcn/Base UI primitives from `@multica/ui` (grep the Lark/Slack settings page for the exact imports — `Input`, `Button`, `Label`, `Card`). Wire fields to `window.jiraAPI.getConfig()`/`setConfig()` and the `useJiraSync` hook. Keep it minimal: site URL, email, API token (password input), JQL textarea, poll interval, status-mapping key/value editor, "Sync now" button, and a results line (`created / updated / commentsAdded`, plus any errors). Use semantic tokens (`bg-background`, `text-muted-foreground`), no hardcoded colors. Gate the whole page behind a `window.jiraAPI` presence check, rendering a "desktop only" notice on web.

(Full JSX is mechanical; follow `packages/views/settings/lark/` as the structural template so layout/spacing/i18n match.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @multica/views test -- jira-settings`
Expected: PASS.

- [ ] **Step 5: Wire navigation + commit**

Add the Jira settings entry to the settings navigation the same way Lark/Slack are registered, then:

```bash
git add packages/views/settings/jira/jira-settings.tsx packages/views/settings/jira/jira-settings.test.tsx packages/views/settings/<nav-file>
git commit -m "feat(views): Jira sync settings page"
```

---

## Task 13: issue 列表来源徽标

**Files:**
- Modify: the issue list row/card component in `packages/views/issues/` (locate the component that renders a single issue row)
- Test: co-located `*.test.tsx` for that component (append a case)

- [ ] **Step 1: Write the failing test**

Append to the issue-row component's test (mirror its existing render harness):

```tsx
it("shows a Jira badge for jira-sourced issues", () => {
  renderRow({ ...baseIssue, metadata: { source: "jira", jira_url: "https://acme.atlassian.net/browse/PROJ-1" } });
  const badge = screen.getByText(/jira/i);
  expect(badge).toBeInTheDocument();
});

it("shows no Jira badge for user-created issues", () => {
  renderRow({ ...baseIssue, metadata: {} });
  expect(screen.queryByText(/jira/i)).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @multica/views test -- <issue-row-test-name>`
Expected: FAIL — no Jira badge rendered.

- [ ] **Step 3: Write minimal implementation**

In the issue-row component, read `issue.metadata?.source === "jira"` (explicit `=== "jira"` per the repo's explicit-boolean-check rule) and render a small `Badge` (from `@multica/ui`) linking to `issue.metadata.jira_url`. Use semantic tokens. Optional-chain metadata defensively.

```tsx
{issue.metadata?.source === "jira" && (
  <a href={String(issue.metadata.jira_url ?? "")} target="_blank" rel="noreferrer">
    <Badge variant="outline">Jira</Badge>
  </a>
)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @multica/views test -- <issue-row-test-name>`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/views/issues/<component>.tsx packages/views/issues/<component>.test.tsx
git commit -m "feat(views): Jira source badge on issue rows"
```

---

## Task 14: 主进程轮询定时器

**Files:**
- Modify: `apps/desktop/src/main/jira.ts` (add a poll scheduler) or `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/src/main/jira.test.ts` (append scheduler tests)

The actual sync runs in the renderer (it needs the workspace `ApiClient`). The main process timer just signals the renderer to run a sync via an event channel; the renderer subscribes and calls `useJiraSync().syncNow()`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";
import { computePollDelayMs } from "./jira";

describe("computePollDelayMs", () => {
  it("returns 0 when polling is disabled", () => {
    expect(computePollDelayMs(0)).toBe(0);
  });
  it("converts minutes to ms", () => {
    expect(computePollDelayMs(15)).toBe(15 * 60 * 1000);
  });
  it("clamps absurdly small intervals to a 1-minute floor", () => {
    expect(computePollDelayMs(0.1)).toBe(60 * 1000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @multica/desktop test -- main/jira`
Expected: FAIL — `computePollDelayMs` not exported.

- [ ] **Step 3: Write minimal implementation**

In `apps/desktop/src/main/jira.ts`:

```ts
export function computePollDelayMs(minutes: number): number {
  if (!minutes || minutes <= 0) return 0;
  return Math.max(1, minutes) * 60 * 1000;
}
```

Then add a scheduler that, on config change and at startup, sets an interval which sends `mainWindow.webContents.send("jira:poll-tick")`. The renderer subscribes via a preload-exposed `onPollTick(cb)` (add to `jiraAPI` mirroring `daemonAPI`'s event-subscription methods) and calls `syncNow()`. Keep the channel name `jira:poll-tick`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @multica/desktop test -- main/jira`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/main/jira.ts apps/desktop/src/main/jira.test.ts apps/desktop/src/preload/index.ts apps/desktop/src/preload/index.d.ts
git commit -m "feat(desktop): periodic Jira sync poll tick to the renderer"
```

---

## Task 15: 端到端校验

**Files:** none (verification only)

- [ ] **Step 1: Typecheck the whole workspace**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 2: Run the unit suites**

Run: `pnpm --filter @multica/core test && pnpm --filter @multica/views test && pnpm --filter @multica/desktop test`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: PASS (fix any issues in touched files).

- [ ] **Step 4: Manual smoke (desktop)**

Launch `pnpm dev:desktop`, open Settings → Jira, enter a real Jira site/email/API token + JQL, click "Sync now". Confirm: issues appear in Multica with a Jira badge, subtasks nest under parents, comments appear, re-running does not duplicate.

- [ ] **Step 5: Final commit (if any fixups)**

```bash
git add -A
git commit -m "chore(jira): verification fixups"
```

---

## Self-Review Notes

- **Spec coverage:** metadata model (T1), Jira schemas/parse (T2), ADF (T3), field/status mapping incl. defaults+override (T4), metadata API (T5), dedup+create+update+skip+errors (T6), subtasks+comments high-water (T7), desktop IPC+config+CORS-bypass (T9–T10), trigger manual (T11–T12) + poll (T14), source badge (T13), tests throughout, e2e (T15). One-way only; write-back explicitly out of scope per spec.
- **Open confirmations flagged inline** (do before relying on them): metadata GET response shape (T5), `listIssues` param signature (T6), views `ApiClient` accessor pattern (T11), desktop test runner command + preload exposure mechanism (T9–T10), settings nav registration + issue-row component location (T12–T13).
- **Type consistency:** `JiraTransport`, `JiraConfig`, `SyncDeps`, `SyncResult` defined in T2 and used unchanged in T6/T7/T11; metadata key constants from T1 used in T6/T7/T13.
