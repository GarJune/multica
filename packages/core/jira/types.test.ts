import { describe, expect, it } from "vitest";
import { parseJiraSearch } from "./types";

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
    expect(res.issues[0]!.key).toBe("PROJ-1");
    expect(res.issues[0]!.fields.status.name).toBe("In Progress");
    expect(res.issues[0]!.fields.subtasks[0]!.key).toBe("PROJ-2");
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
    expect(res.issues[0]!.fields.priority).toBeNull();
    expect(res.issues[0]!.fields.subtasks).toEqual([]);
    expect(res.issues[0]!.fields.comment.comments).toEqual([]);
  });
});
