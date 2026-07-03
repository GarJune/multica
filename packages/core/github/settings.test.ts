import { describe, it, expect } from "vitest";
import { deriveGitHubSettings } from "./settings";
import type { Workspace } from "../types";

function ws(settings: Record<string, unknown>): Pick<Workspace, "settings"> {
  return { settings };
}

describe("deriveGitHubSettings", () => {
  it("defaults every flag to true when workspace is null", () => {
    expect(deriveGitHubSettings(null)).toEqual({
      enabled: true,
      prSidebar: true,
      coAuthor: true,
      autoLinkPRs: true,
      autoCloseIssueOnPRMerge: true,
    });
  });

  it("defaults every flag to true on empty settings", () => {
    expect(deriveGitHubSettings(ws({}))).toEqual({
      enabled: true,
      prSidebar: true,
      coAuthor: true,
      autoLinkPRs: true,
      autoCloseIssueOnPRMerge: true,
    });
  });

  it("master switch off forces every dependent flag off", () => {
    const got = deriveGitHubSettings(
      ws({
        github_enabled: false,
        github_pr_sidebar_enabled: true,
        co_authored_by_enabled: true,
        github_auto_link_prs_enabled: true,
        github_auto_close_issue_on_pr_merge_enabled: true,
      }),
    );
    expect(got).toEqual({
      enabled: false,
      prSidebar: false,
      coAuthor: false,
      autoLinkPRs: false,
      autoCloseIssueOnPRMerge: false,
    });
  });

  it("each sub-flag can be flipped independently when master is on", () => {
    expect(
      deriveGitHubSettings(ws({ github_pr_sidebar_enabled: false })),
    ).toMatchObject({
      enabled: true,
      prSidebar: false,
      coAuthor: true,
      autoLinkPRs: true,
      autoCloseIssueOnPRMerge: true,
    });

    expect(
      deriveGitHubSettings(ws({ co_authored_by_enabled: false })),
    ).toMatchObject({
      enabled: true,
      prSidebar: true,
      coAuthor: false,
      autoLinkPRs: true,
      autoCloseIssueOnPRMerge: true,
    });

    expect(
      deriveGitHubSettings(ws({ github_auto_link_prs_enabled: false })),
    ).toMatchObject({
      enabled: true,
      prSidebar: true,
      coAuthor: true,
      autoLinkPRs: false,
      // autoCloseIssueOnPRMerge is decoupled from auto-link at the derivation
      // layer — the UI is responsible for disabling the switch when
      // autoLinkPRs is off (since a link that never happens can never trigger
      // auto-done anyway). Keeping them independent here means re-enabling
      // auto-link doesn't silently flip the auto-done flag.
      autoCloseIssueOnPRMerge: true,
    });

    expect(
      deriveGitHubSettings(
        ws({ github_auto_close_issue_on_pr_merge_enabled: false }),
      ),
    ).toMatchObject({
      enabled: true,
      prSidebar: true,
      coAuthor: true,
      autoLinkPRs: true,
      autoCloseIssueOnPRMerge: false,
    });
  });

  it("treats non-false values (true, null, missing) as enabled", () => {
    expect(
      deriveGitHubSettings(
        ws({ github_enabled: true, github_pr_sidebar_enabled: null }),
      ),
    ).toMatchObject({ enabled: true, prSidebar: true });
    expect(
      deriveGitHubSettings(
        ws({ github_auto_close_issue_on_pr_merge_enabled: null }),
      ),
    ).toMatchObject({ autoCloseIssueOnPRMerge: true });
  });
});
