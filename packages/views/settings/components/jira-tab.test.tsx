import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const mockSyncNow = vi.hoisted(() => vi.fn());

vi.mock("../jira/use-jira-sync", () => ({
  useJiraSync: () => ({
    syncNow: mockSyncNow,
    running: false,
    lastResult: { created: 3, updated: 1, skipped: 0, commentsAdded: 2, errors: [] },
    error: null,
  }),
}));

import { JiraTab } from "./jira-tab";

function installJiraAPI() {
  (globalThis as unknown as { window: { jiraAPI: unknown } }).window.jiraAPI = {
    request: vi.fn(),
    getConfig: vi.fn().mockResolvedValue({
      siteUrl: "https://acme.atlassian.net",
      email: "me@acme.com",
      apiToken: "",
      hasToken: true,
      jql: "assignee = currentUser()",
      statusMapping: {},
      pollIntervalMinutes: 0,
    }),
    setConfig: vi.fn().mockResolvedValue({}),
    onPollTick: vi.fn(),
  };
}

describe("JiraTab", () => {
  beforeEach(() => {
    mockSyncNow.mockReset();
  });

  it("renders connection fields and a sync button on desktop", async () => {
    installJiraAPI();
    render(<JiraTab />);
    expect(await screen.findByLabelText(/site/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /sync now/i })).toBeInTheDocument();
  });

  it("shows last sync counts", async () => {
    installJiraAPI();
    render(<JiraTab />);
    expect(await screen.findByText(/3 created/i)).toBeInTheDocument();
  });

  it("renders a desktop-only notice when jiraAPI is absent", () => {
    delete (globalThis as unknown as { window: { jiraAPI?: unknown } }).window.jiraAPI;
    render(<JiraTab />);
    expect(screen.getByText(/desktop app/i)).toBeInTheDocument();
  });
});
