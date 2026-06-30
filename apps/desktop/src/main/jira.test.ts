import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  ipcMain: { handle: vi.fn() },
  net: { fetch: vi.fn() },
}));

import { buildJiraRequestInit, jiraConfigPath, computePollDelayMs } from "./jira";

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
