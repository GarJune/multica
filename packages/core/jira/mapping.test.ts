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
