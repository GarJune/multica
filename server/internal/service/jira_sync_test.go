package service

import (
	"testing"
	"time"
)

func TestNormalizeJiraSiteURL(t *testing.T) {
	got, err := normalizeJiraSiteURL(" https://company.atlassian.net/ ")
	if err != nil {
		t.Fatalf("normalizeJiraSiteURL returned error: %v", err)
	}
	if got != "https://company.atlassian.net" {
		t.Fatalf("normalizeJiraSiteURL = %q", got)
	}
}

func TestNormalizeJiraSiteURLRejectsInvalidURL(t *testing.T) {
	if _, err := normalizeJiraSiteURL("ftp://company.atlassian.net"); err == nil {
		t.Fatal("expected invalid scheme error")
	}
	if _, err := normalizeJiraSiteURL("not a url"); err == nil {
		t.Fatal("expected invalid URL error")
	}
}

func TestJiraInitialSyncJQLFiltersUnfinishedCurrentUserIssues(t *testing.T) {
	got := buildJiraSyncJQL("PAY", time.Time{})
	want := "project = PAY AND assignee = currentUser() AND statusCategory != Done ORDER BY updated ASC"
	if got != want {
		t.Fatalf("buildJiraSyncJQL = %q, want %q", got, want)
	}
}

func TestJiraDeltaSyncJQLUsesOverlapAndDoesNotFilterDone(t *testing.T) {
	last := time.Date(2026, 6, 29, 10, 0, 0, 0, time.UTC)
	got := buildJiraSyncJQL("PAY", last)
	want := "project = PAY AND assignee = currentUser() AND updated >= \"2026-06-29 09:55\" ORDER BY updated ASC"
	if got != want {
		t.Fatalf("buildJiraSyncJQL = %q, want %q", got, want)
	}
}
