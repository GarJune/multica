import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { JiraBadge } from "./jira-badge";

describe("JiraBadge", () => {
  it("renders a linked badge for jira-sourced issues", () => {
    render(
      <JiraBadge
        issue={{
          metadata: { source: "jira", jira_url: "https://acme.atlassian.net/browse/PROJ-1" },
        }}
      />,
    );
    const link = screen.getByRole("link", { name: /jira/i });
    expect(link).toHaveAttribute("href", "https://acme.atlassian.net/browse/PROJ-1");
  });

  it("renders an unlinked badge when no jira_url is present", () => {
    render(<JiraBadge issue={{ metadata: { source: "jira" } }} />);
    expect(screen.getByText(/jira/i)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("renders nothing for user-created issues", () => {
    const { container } = render(<JiraBadge issue={{ metadata: {} }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
