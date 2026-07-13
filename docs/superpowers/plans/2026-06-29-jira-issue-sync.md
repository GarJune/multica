# Jira Issue Sync Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a polling-only Jira issue integration that mirrors the current Jira user's unfinished assigned issues into Multica and supports write-through Jira comments/status transitions.

**Architecture:** Jira remains the source of truth for Jira-controlled fields. Multica stores local mirror issues plus mapping/sync state, polls Jira every 5 minutes, and routes user actions through Jira REST APIs before refreshing the local mirror. The first implementation should keep backend foundations, sync engine, API actions, and UI surfaces in separate, testable slices.

**Tech Stack:** Go backend (Chi, sqlc, pgx, scheduler, secretbox), PostgreSQL migrations, TypeScript core API client with zod schemas, React Query, shared `packages/views` UI, pnpm/Turborepo.

---

## File Structure / Responsibility Map

### Backend DB / sqlc

- Create: `server/migrations/<next>_jira_integration.up.sql`
  - Creates `jira_connections`, `jira_project_bindings`, `jira_issue_mappings`, `jira_sync_runs`.
  - Extends `issue.origin_type` CHECK constraint to include `jira`.
- Create: `server/migrations/<next>_jira_integration.down.sql`
  - Drops Jira tables and restores previous `origin_type` CHECK constraint.
- Create: `server/pkg/db/queries/jira_integration.sql`
  - sqlc queries for connections, bindings, mappings, and sync runs.
- Modify generated sqlc output after `make sqlc`:
  - `server/pkg/db/generated/*`.

### Backend Jira integration package

- Create: `server/internal/integrations/jira/types.go`
  - Jira DTOs and domain constants.
- Create: `server/internal/integrations/jira/client.go`
  - `APIClient` interface and config structs.
- Create: `server/internal/integrations/jira/http_client.go`
  - REST implementation: `myself`, projects, search, fetch issue, comments, transitions.
- Create: `server/internal/integrations/jira/mapper.go`
  - Jira status/priority/description mapping helpers.
- Create tests:
  - `server/internal/integrations/jira/http_client_test.go`
  - `server/internal/integrations/jira/mapper_test.go`

### Backend services / scheduler / handlers

- Create: `server/internal/service/jira_connection.go`
  - Validates credentials, encrypts/decrypts tokens, upserts connections/bindings.
- Create: `server/internal/service/jira_sync.go`
  - Runs binding sync, builds JQL, pages Jira results, upserts mirror issues.
- Create: `server/internal/service/jira_action.go`
  - Write-through comment and transition operations.
- Modify: `server/internal/service/issue.go`
  - Add an option to suppress automatic agent/squad enqueue for Jira-created mirror issues.
- Create: `server/internal/scheduler/jobs_jira.go`
  - Registers 5-minute Jira sync job with binding scopes.
- Modify server startup/router wiring where scheduler jobs and handlers are registered.
  - Locate exact files before implementation with grep/glob.
- Create: `server/internal/handler/jira_integration.go`
  - Connection, project listing, binding, Sync Now endpoints.
- Create: `server/internal/handler/jira_action.go`
  - Jira comment and transition endpoints.
- Create tests:
  - `server/internal/service/jira_connection_test.go`
  - `server/internal/service/jira_sync_test.go`
  - `server/internal/service/jira_action_test.go`
  - `server/internal/scheduler/jobs_jira_test.go`
  - `server/internal/handler/jira_integration_test.go`
  - `server/internal/handler/jira_action_test.go`

### Frontend core

- Modify: `packages/core/types/issue.ts`
  - Add typed Jira metadata helper types or predicates without changing core `Issue` shape unnecessarily.
- Create: `packages/core/types/jira.ts`
  - Jira connection/binding/project/sync/action response types.
- Modify: `packages/core/types/index.ts`
  - Export Jira types.
- Modify: `packages/core/api/schemas.ts`
  - Add lenient zod schemas and EMPTY fallbacks for Jira endpoints.
- Modify: `packages/core/api/client.ts`
  - Add Jira integration methods.
- Create: `packages/core/jira/queries.ts`
  - React Query keys/options for connections/projects/bindings/transitions.
- Create: `packages/core/jira/mutations.ts`
  - Mutations for save connection, create binding, sync now, comment, transition.
- Create: `packages/core/jira/index.ts`
  - Public exports.
- Create tests:
  - `packages/core/jira/queries.test.ts` if patterns support unit testing keys/options.
  - Add schema malformed-response tests near existing API schema tests if present.

### Frontend views

- Create: `packages/views/settings/jira/` or existing settings integration location after locating patterns.
  - `jira-settings-page.tsx`
  - `jira-connection-form.tsx`
  - `jira-project-binding-card.tsx`
- Modify web/desktop settings routing to expose Jira settings page.
  - Locate settings route files before editing.
- Modify: `packages/views/issues/components/issue-detail.tsx`
  - Show Jira source metadata and actions for Jira issues.
- Modify: issue cards/rows as needed:
  - `packages/views/issues/components/board-card.tsx`
  - `packages/views/issues/components/list-row.tsx`
  - `packages/views/issues/components/issue-chip.tsx`
- Create: `packages/views/issues/components/jira-source-badge.tsx`
- Create: `packages/views/issues/components/jira-actions.tsx`
- Modify: `packages/views/issues/actions/use-issue-actions.ts` only if action menu integration is cleaner than issue-detail-local actions.
- Create/update tests:
  - `packages/views/issues/components/issue-detail.test.tsx`
  - card/row tests where badges are rendered.
  - new settings page tests if existing settings tests are present.

### Docs / generated artifacts

- Existing design doc in main checkout: `docs/tech-design/jira_issue_sync_技术方案.md`.
- Copy or recreate into worktree if needed before implementation commits.
- Run `make sqlc` after DB query/migration changes.

---

## Chunk 1: Backend Persistence Foundation

### Task 1: Add Jira integration migration

**Files:**
- Create: `server/migrations/<next>_jira_integration.up.sql`
- Create: `server/migrations/<next>_jira_integration.down.sql`
- Test via command: migration up/down on worktree DB.

- [ ] **Step 1: Inspect latest migration number**

Run:

```bash
ls server/migrations | sort | tail
```

Expected: identify the next numeric prefix after the current latest migration.

- [ ] **Step 2: Write failing migration smoke check**

Before writing migrations, run:

```bash
cd server && go run ./cmd/migrate up
```

Expected: PASS on baseline. If it fails, stop and report baseline failure.

- [ ] **Step 3: Create migration DDL**

Create the up migration with:

```sql
create table jira_connections (...);
create table jira_project_bindings (...);
create table jira_issue_mappings (...);
create table jira_sync_runs (...);
```

Requirements:

- Include `workspace_id` on every table.
- Include `on delete cascade` FKs from binding -> connection, mapping -> connection/binding/issue, sync_run -> binding.
- Include unique keys from design.
- Extend issue origin type CHECK to include `jira`.
- Preserve existing `autopilot`, `quick_create`, `lark_chat` values.

- [ ] **Step 4: Create down migration**

Down migration must:

- Drop Jira tables in dependency order.
- Restore issue origin type CHECK to its previous allowed values.

- [ ] **Step 5: Verify migrations**

Run:

```bash
cd server && go run ./cmd/migrate up
cd server && go run ./cmd/migrate down 1
cd server && go run ./cmd/migrate up
```

Expected: all commands exit 0.

### Task 2: Add sqlc queries for Jira tables

**Files:**
- Create: `server/pkg/db/queries/jira_integration.sql`
- Generated: `server/pkg/db/generated/*`
- Test: sqlc generation and compile.

- [ ] **Step 1: Write query file**

Add queries for:

- `UpsertJiraConnection`
- `GetJiraConnectionInWorkspaceForMember`
- `ListJiraConnectionsForMember`
- `UpsertJiraProjectBinding`
- `GetJiraProjectBindingForMember`
- `ListDueJiraProjectBindings`
- `UpdateJiraProjectBindingSyncStarted`
- `UpdateJiraProjectBindingSyncSucceeded`
- `UpdateJiraProjectBindingSyncFailed`
- `GetJiraIssueMappingByJiraID`
- `GetJiraIssueMappingByIssueID`
- `CreateJiraIssueMapping`
- `UpdateJiraIssueMapping`
- `CreateJiraSyncRun`
- `FinishJiraSyncRun`
- `ListJiraSyncRunsForBinding`

- [ ] **Step 2: Run sqlc generation**

Run:

```bash
make sqlc
```

Expected: generated Go compiles, no sqlc errors.

- [ ] **Step 3: Run targeted Go compile**

Run:

```bash
cd server && go test ./pkg/db/generated
```

Expected: PASS or no test files with successful compile.

---

## Chunk 2: Jira Client and Mapping Helpers

### Task 3: Add Jira API client interface and HTTP implementation

**Files:**
- Create: `server/internal/integrations/jira/types.go`
- Create: `server/internal/integrations/jira/client.go`
- Create: `server/internal/integrations/jira/http_client.go`
- Create: `server/internal/integrations/jira/http_client_test.go`

- [ ] **Step 1: Write failing client tests**

Test cases:

- `Myself` sends Basic Auth for `cloud_api_token` with email/token.
- `Myself` sends Bearer Auth for `pat`.
- Base URL is normalized without trailing slash.
- `ListProjects` parses project id/key/name/avatar.
- `SearchIssues` passes JQL and `fields` filter.
- 401/403/429 become typed/user-readable errors without leaking token.

Run:

```bash
cd server && go test ./internal/integrations/jira -run 'TestHTTPClient' -count=1
```

Expected: FAIL because package/files do not exist yet.

- [ ] **Step 2: Implement minimal client**

Implement:

```go
type APIClient interface {
    Myself(ctx context.Context, creds Credentials) (User, error)
    ListProjects(ctx context.Context, creds Credentials) ([]Project, error)
    SearchIssues(ctx context.Context, creds Credentials, req SearchIssuesRequest) (SearchIssuesResponse, error)
    GetIssue(ctx context.Context, creds Credentials, issueIDOrKey string) (Issue, error)
    AddComment(ctx context.Context, creds Credentials, issueIDOrKey string, body string) (Comment, error)
    ListTransitions(ctx context.Context, creds Credentials, issueIDOrKey string) ([]Transition, error)
    DoTransition(ctx context.Context, creds Credentials, issueIDOrKey string, transitionID string) error
}
```

Follow Lark client style: injected `*http.Client`, configurable base URL for tests, per-call context, small DTOs.

- [ ] **Step 3: Run client tests**

Run:

```bash
cd server && go test ./internal/integrations/jira -run 'TestHTTPClient' -count=1
```

Expected: PASS.

### Task 4: Add Jira field mapping helpers

**Files:**
- Create: `server/internal/integrations/jira/mapper.go`
- Create: `server/internal/integrations/jira/mapper_test.go`

- [ ] **Step 1: Write failing mapper tests**

Test cases:

- Jira `statusCategory.key=new` maps to Multica `todo`.
- Jira `statusCategory.key=indeterminate` maps to `in_progress`.
- Jira `statusCategory.key=done` maps to `done`.
- Unknown status maps to `in_progress` and preserves raw status in metadata.
- Priority names map according to the design.
- ADF description converts to readable text; malformed description does not fail the whole issue.

Run:

```bash
cd server && go test ./internal/integrations/jira -run 'TestMap' -count=1
```

Expected: FAIL before implementation.

- [ ] **Step 2: Implement mapping helpers**

Implement pure functions only; no DB/network dependencies.

- [ ] **Step 3: Run mapper tests**

Run:

```bash
cd server && go test ./internal/integrations/jira -run 'TestMap' -count=1
```

Expected: PASS.

---

## Chunk 3: Backend Services and Sync Engine

### Task 5: Implement connection and project binding services

**Files:**
- Create: `server/internal/service/jira_connection.go`
- Create: `server/internal/service/jira_connection_test.go`

- [ ] **Step 1: Write failing service tests**

Test cases:

- Creating connection validates credentials via `APIClient.Myself` before DB write.
- Token is encrypted with `secretbox` before persistence.
- Same workspace/member/site upserts instead of duplicating.
- `cloud_api_token` requires email.
- Binding creation rejects connections not owned by current member.
- Binding upserts same project key for same connection.

Run:

```bash
cd server && go test ./internal/service -run 'TestJiraConnection|TestJiraProjectBinding' -count=1
```

Expected: FAIL before service exists.

- [ ] **Step 2: Implement services**

Implement minimal service methods:

- `UpsertConnection`
- `ListConnectionProjects`
- `UpsertProjectBinding`
- credential decrypt helper for sync/action services.

- [ ] **Step 3: Run service tests**

Run:

```bash
cd server && go test ./internal/service -run 'TestJiraConnection|TestJiraProjectBinding' -count=1
```

Expected: PASS.

### Task 6: Add IssueService option to suppress enqueue

**Files:**
- Modify: `server/internal/service/issue.go`
- Add/modify tests in: `server/internal/service/*issue*_test.go`

- [ ] **Step 1: Write failing test**

Test: creating an issue with new `IssueCreateOpts.SuppressEnqueue` (or final chosen name) does not call task enqueue even when assignee is an agent/squad and status is not backlog.

Run:

```bash
cd server && go test ./internal/service -run 'TestIssueCreate.*Suppress.*Enqueue' -count=1
```

Expected: FAIL before option exists.

- [ ] **Step 2: Implement suppress option**

Add field to `IssueCreateOpts`, guard `maybeEnqueueOnAssign` call.

- [ ] **Step 3: Run targeted issue service tests**

Run:

```bash
cd server && go test ./internal/service -run 'TestIssueCreate|TestTaskIssueBroadcast' -count=1
```

Expected: PASS.

### Task 7: Implement Jira mirror upsert service

**Files:**
- Create/modify: `server/internal/service/jira_sync.go`
- Create: `server/internal/service/jira_sync_test.go`

- [ ] **Step 1: Write failing mirror tests**

Test cases:

- New non-Done Jira issue creates Multica issue with `origin_type=jira` and `origin_id=mapping_id`.
- New Done Jira issue without mapping is skipped.
- Existing mapping with newer Jira updated time updates title/status/priority/metadata.
- Existing mapping with same/older Jira updated time is skipped.
- Sync update does not overwrite local assignee after reassignment.
- Jira issue creation uses `SuppressEnqueue`.

Run:

```bash
cd server && go test ./internal/service -run 'TestJiraSyncUpsert' -count=1
```

Expected: FAIL before implementation.

- [ ] **Step 2: Implement mirror upsert**

Implement `UpsertIssueFromJira` using generated queries and `IssueService.Create`.

- [ ] **Step 3: Run mirror tests**

Run:

```bash
cd server && go test ./internal/service -run 'TestJiraSyncUpsert' -count=1
```

Expected: PASS.

### Task 8: Implement binding sync runner

**Files:**
- Modify: `server/internal/service/jira_sync.go`
- Modify: `server/internal/service/jira_sync_test.go`

- [ ] **Step 1: Write failing sync runner tests**

Test cases:

- Initial sync builds JQL with `statusCategory != Done`.
- Delta sync builds JQL without Done filter and uses `last_successful_sync_at - 5m`.
- Pagination processes all pages.
- One issue failure marks run failed and does not advance cursor.
- Successful run updates `last_successful_sync_at` and clears `last_error`.

Run:

```bash
cd server && go test ./internal/service -run 'TestJiraRunBindingSync' -count=1
```

Expected: FAIL before implementation.

- [ ] **Step 2: Implement sync runner**

Implement `RunBindingSync(ctx, bindingID, runType)` or equivalent.

- [ ] **Step 3: Run sync tests**

Run:

```bash
cd server && go test ./internal/service -run 'TestJiraRunBindingSync|TestJiraSyncUpsert' -count=1
```

Expected: PASS.

---

## Chunk 4: Scheduler and Backend HTTP API

### Task 9: Register Jira polling scheduler job

**Files:**
- Create: `server/internal/scheduler/jobs_jira.go`
- Create: `server/internal/scheduler/jobs_jira_test.go`
- Modify startup scheduler registration file after locating it.

- [ ] **Step 1: Locate scheduler registration**

Run:

```bash
grep -R "AutopilotScheduleDispatchJob\|jobs_task_usage\|Register" -n server/internal server/cmd | head -50
```

Expected: identify where jobs are assembled.

- [ ] **Step 2: Write failing scheduler tests**

Test cases:

- Job name is `jira_polling_sync`.
- Scope kind is `jira_project_binding`.
- Cadence is 5 minutes.
- Disabled bindings are not scoped.
- Handler calls sync service with binding ID and run type `scheduled`.

Run:

```bash
cd server && go test ./internal/scheduler -run 'TestJira' -count=1
```

Expected: FAIL before job exists.

- [ ] **Step 3: Implement job and registration**

Follow scheduler `JobSpec` patterns. Keep scope provider query-driven; do not keep in-memory timers.

- [ ] **Step 4: Run scheduler tests**

Run:

```bash
cd server && go test ./internal/scheduler -run 'TestJira|TestJobSpec' -count=1
```

Expected: PASS.

### Task 10: Add Jira integration HTTP handlers

**Files:**
- Create: `server/internal/handler/jira_integration.go`
- Create: `server/internal/handler/jira_integration_test.go`
- Modify router registration file after locating it.

- [ ] **Step 1: Locate route registration**

Run:

```bash
grep -R "Post(\|Get(\|Route(\|/api/issues\|/api/integrations" -n server/internal/handler server/cmd | head -80
```

Expected: identify correct route wiring file(s).

- [ ] **Step 2: Write failing handler tests**

Test cases:

- `POST /api/integrations/jira/connections` validates required fields.
- Successful connection does not return token.
- `GET /connections/:id/projects` enforces workspace/member ownership.
- `POST /project-bindings` creates/upserts binding.
- `POST /project-bindings/:id/sync` returns sync run result.

Run:

```bash
cd server && go test ./internal/handler -run 'TestJiraIntegration' -count=1
```

Expected: FAIL before handlers/routes exist.

- [ ] **Step 3: Implement handlers and route registration**

Use existing handler helpers:

- `requireUserID`
- workspace resolution helpers
- UUID parse helpers
- `writeJSON` / `writeError`

- [ ] **Step 4: Run handler tests**

Run:

```bash
cd server && go test ./internal/handler -run 'TestJiraIntegration' -count=1
```

Expected: PASS.

### Task 11: Add Jira issue action HTTP handlers

**Files:**
- Create: `server/internal/service/jira_action.go`
- Create: `server/internal/service/jira_action_test.go`
- Create: `server/internal/handler/jira_action.go`
- Create: `server/internal/handler/jira_action_test.go`
- Modify route registration file.

- [ ] **Step 1: Write failing service tests**

Test cases:

- Comment action rejects non-Jira issue.
- Comment action calls Jira API and only records local activity after Jira success.
- Transition list returns available Jira transitions.
- Transition action calls Jira API, fetches issue, and refreshes mirror.
- Jira API failures do not update local issue status.

Run:

```bash
cd server && go test ./internal/service -run 'TestJiraAction' -count=1
```

Expected: FAIL before service exists.

- [ ] **Step 2: Implement action service**

Reuse mapping lookup and credential decrypt from connection/sync services.

- [ ] **Step 3: Write failing handler tests**

Run:

```bash
cd server && go test ./internal/handler -run 'TestJiraAction' -count=1
```

Expected: FAIL before handlers/routes exist.

- [ ] **Step 4: Implement handlers and routes**

Add:

- `POST /api/issues/:id/jira/comments`
- `GET /api/issues/:id/jira/transitions`
- `POST /api/issues/:id/jira/transitions`

- [ ] **Step 5: Run action tests**

Run:

```bash
cd server && go test ./internal/service ./internal/handler -run 'TestJiraAction' -count=1
```

Expected: PASS.

---

## Chunk 5: Frontend Core API and Hooks

### Task 12: Add Jira types, schemas, and API client methods

**Files:**
- Create: `packages/core/types/jira.ts`
- Modify: `packages/core/types/index.ts`
- Modify: `packages/core/types/issue.ts`
- Modify: `packages/core/api/schemas.ts`
- Modify: `packages/core/api/client.ts`

- [ ] **Step 1: Add failing type/schema tests if existing schema tests are present**

Find schema test patterns:

```bash
grep -R "parseWithFallback\|Schema" -n packages/core --include='*.test.ts'
```

If present, add malformed response tests for Jira connection/binding/sync response. If absent, add types/schemas without new test file and rely on typecheck.

- [ ] **Step 2: Implement Jira types and issue metadata helpers**

Add types for:

- `JiraConnection`
- `JiraProject`
- `JiraProjectBinding`
- `JiraSyncRun`
- `JiraTransition`
- `JiraCommentResponse`
- `JiraIssueMetadata` / `isJiraIssue(issue)` helper.

- [ ] **Step 3: Implement zod schemas**

Schemas must be lenient (`.loose()`) and have EMPTY fallbacks matching project style.

- [ ] **Step 4: Add ApiClient methods**

Add methods:

- `createJiraConnection`
- `listJiraProjects`
- `createJiraProjectBinding`
- `syncJiraProjectBinding`
- `commentOnJiraIssue`
- `listJiraIssueTransitions`
- `transitionJiraIssue`

Use `parseWithFallback` for response parsing.

- [ ] **Step 5: Run typecheck for core package**

Run:

```bash
pnpm typecheck --filter=@multica/core
```

Expected: PASS.

### Task 13: Add React Query hooks for Jira integration

**Files:**
- Create: `packages/core/jira/queries.ts`
- Create: `packages/core/jira/mutations.ts`
- Create: `packages/core/jira/index.ts`

- [ ] **Step 1: Implement query keys/options**

Keys should include `wsId` and relevant connection/binding IDs.

- [ ] **Step 2: Implement mutations**

Mutations should invalidate relevant Jira query keys and issue query keys after sync/comment/transition.

- [ ] **Step 3: Run core typecheck**

Run:

```bash
pnpm typecheck --filter=@multica/core
```

Expected: PASS.

---

## Chunk 6: Frontend Views and Issue UI

### Task 14: Add Jira settings UI

**Files:**
- Create settings Jira components in the existing settings area after locating patterns.
- Modify web/desktop route wiring to expose Settings / Integrations / Jira.
- Tests: matching settings view tests if patterns exist.

- [ ] **Step 1: Locate settings patterns**

Run:

```bash
grep -R "Settings\|Integrations\|Runtimes\|Slack\|Lark" -n packages/views apps/web apps/desktop --include='*.tsx' | head -100
```

Expected: identify where integration settings belong.

- [ ] **Step 2: Write/adjust tests for settings UI**

Test cases:

- Form does not expose token after save.
- Successful connection loads projects.
- Creating binding triggers Sync Now or shows Sync Now button.
- Last sync/error render correctly.

Run likely command after locating package test pattern:

```bash
pnpm test --filter=@multica/views -- --run jira
```

Expected: FAIL before UI exists.

- [ ] **Step 3: Implement UI components**

Use shared UI components and React Query hooks from `@multica/core/jira`.

- [ ] **Step 4: Wire platform routes**

Keep `packages/views` free of `next/*` and `react-router-dom`; route wiring belongs in apps/platform layers.

- [ ] **Step 5: Run targeted tests/typecheck**

Run:

```bash
pnpm typecheck --filter=@multica/views
pnpm typecheck --filter=@multica/web
pnpm typecheck --filter=@multica/desktop
```

Expected: PASS.

### Task 15: Add Jira badge and issue detail actions

**Files:**
- Create: `packages/views/issues/components/jira-source-badge.tsx`
- Create: `packages/views/issues/components/jira-actions.tsx`
- Modify: `packages/views/issues/components/issue-detail.tsx`
- Modify as needed: `packages/views/issues/components/board-card.tsx`
- Modify as needed: `packages/views/issues/components/list-row.tsx`
- Modify as needed: `packages/views/issues/components/issue-chip.tsx`
- Tests: `packages/views/issues/components/issue-detail.test.tsx` and relevant card/row tests.

- [ ] **Step 1: Write failing UI tests**

Test cases:

- Jira issue renders `Jira PAY-123` badge.
- Local issue does not render Jira badge/actions.
- Open in Jira uses `metadata.jiraUrl`.
- Comment action calls Jira comment mutation, not local comment mutation.
- Transition action loads Jira transitions and calls transition mutation.

Run:

```bash
pnpm test --filter=@multica/views -- --run issue-detail
```

Expected: FAIL before UI exists.

- [ ] **Step 2: Implement metadata helper usage**

Use `isJiraIssue(issue)` and metadata accessors from core; optional-chain all Jira metadata.

- [ ] **Step 3: Implement badges in card/list/detail**

Display `MUL-456 · Jira PAY-123` style without replacing Multica identifier.

- [ ] **Step 4: Implement Jira actions**

Actions:

- Open in Jira
- Comment to Jira
- Change Jira status

Do not expose title/description/priority editing for Jira-controlled fields in first version.

- [ ] **Step 5: Run targeted UI tests/typecheck**

Run:

```bash
pnpm test --filter=@multica/views -- --run issue-detail
pnpm typecheck --filter=@multica/views
```

Expected: PASS.

---

## Chunk 7: Integration Verification and Cleanup

### Task 16: Backend full verification

**Files:**
- No new source files expected unless fixing failures.

- [ ] **Step 1: Run Go tests for touched backend packages**

Run:

```bash
cd server && go test ./internal/integrations/jira ./internal/service ./internal/handler ./internal/scheduler ./pkg/db/generated
```

Expected: PASS.

- [ ] **Step 2: Run broader backend tests if targeted pass**

Run:

```bash
make test
```

Expected: PASS or report pre-existing failures with evidence.

### Task 17: Frontend full verification

**Files:**
- No new source files expected unless fixing failures.

- [ ] **Step 1: Run TypeScript checks**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 2: Run TS tests**

Run:

```bash
pnpm test
```

Expected: PASS or report pre-existing failures with evidence.

### Task 18: Final review and commit slicing

**Files:**
- All changed files.

- [ ] **Step 1: Inspect working tree**

Run:

```bash
GIT_MASTER=1 git status --short
GIT_MASTER=1 git diff --stat
```

Expected: only intended Jira sync files changed.

- [ ] **Step 2: Request code review**

Use `review-work` or `superpowers/requesting-code-review` before final completion.

- [ ] **Step 3: Create atomic commits only if user asks to commit**

Follow `git-master` rules. Expected commit grouping:

1. DB migrations + sqlc queries/generated.
2. Jira integration client + mapping helpers + tests.
3. backend services + tests.
4. scheduler + handler APIs + tests.
5. frontend core types/api/hooks.
6. frontend settings UI.
7. issue UI badge/actions.

Do not commit unless explicitly requested.

---

## Execution Notes

- Worktree path: `/Users/joyy/.config/superpowers/worktrees/multica/jira-issue-sync`.
- Branch: `feature/jira-issue-sync`.
- Run `make worktree-env` already generated `.env.worktree`.
- Before implementation, run `make setup-worktree` if dependencies/DB are not ready.
- The original design doc exists in the main checkout at `docs/tech-design/jira_issue_sync_技术方案.md`; copy it to this worktree if it should be part of this branch.
- Keep implementation surgical. Do not add OAuth, webhook, custom JQL, attachment sync, Jira assignee editing, or full two-way sync.
- Use Jira API write-through for comments and transitions only.
- Do not use `as any`, `@ts-ignore`, or `@ts-expect-error`.
