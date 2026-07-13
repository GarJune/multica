package jira

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestHTTPClientMyselfUsesBasicAuthForCloudAPIToken(t *testing.T) {
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/rest/api/3/myself" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"accountId":    "acct-1",
			"displayName":  "Alice",
			"emailAddress": "alice@example.com",
		})
	}))
	defer server.Close()

	client := NewHTTPClient(HTTPClientConfig{HTTPClient: server.Client()})
	user, err := client.Myself(context.Background(), Credentials{
		SiteURL:  server.URL + "/",
		AuthType: AuthTypeCloudAPIToken,
		Email:    "alice@example.com",
		Token:    "secret-token",
	})
	if err != nil {
		t.Fatalf("Myself returned error: %v", err)
	}
	if user.AccountID != "acct-1" || user.DisplayName != "Alice" || user.EmailAddress != "alice@example.com" {
		t.Fatalf("unexpected user: %#v", user)
	}

	wantAuth := "Basic " + base64.StdEncoding.EncodeToString([]byte("alice@example.com:secret-token"))
	if gotAuth != wantAuth {
		t.Fatalf("Authorization = %q, want %q", gotAuth, wantAuth)
	}
}

func TestHTTPClientMyselfUsesBearerAuthForPAT(t *testing.T) {
	var gotAuth string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"accountId":   "acct-2",
			"displayName": "Bob",
		})
	}))
	defer server.Close()

	client := NewHTTPClient(HTTPClientConfig{HTTPClient: server.Client()})
	if _, err := client.Myself(context.Background(), Credentials{
		SiteURL:  server.URL,
		AuthType: AuthTypePAT,
		Token:    "pat-token",
	}); err != nil {
		t.Fatalf("Myself returned error: %v", err)
	}

	if gotAuth != "Bearer pat-token" {
		t.Fatalf("Authorization = %q, want Bearer token", gotAuth)
	}
}

func TestHTTPClientListProjectsParsesProjects(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/rest/api/3/project/search" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"values": []map[string]any{{
				"id":             "10001",
				"key":            "PAY",
				"name":           "Payment Platform",
				"projectTypeKey": "software",
				"avatarUrls": map[string]string{
					"48x48": "https://avatar.example/pay.png",
				},
			}},
		})
	}))
	defer server.Close()

	client := NewHTTPClient(HTTPClientConfig{HTTPClient: server.Client()})
	projects, err := client.ListProjects(context.Background(), Credentials{SiteURL: server.URL, AuthType: AuthTypePAT, Token: "pat"})
	if err != nil {
		t.Fatalf("ListProjects returned error: %v", err)
	}
	if len(projects) != 1 {
		t.Fatalf("len(projects) = %d, want 1", len(projects))
	}
	project := projects[0]
	if project.ID != "10001" || project.Key != "PAY" || project.Name != "Payment Platform" || project.ProjectTypeKey != "software" || project.AvatarURL != "https://avatar.example/pay.png" {
		t.Fatalf("unexpected project: %#v", project)
	}
}

func TestHTTPClientSearchIssuesSendsJQLAndFields(t *testing.T) {
	var gotQuery url.Values
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/rest/api/3/search" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		gotQuery = r.URL.Query()
		_ = json.NewEncoder(w).Encode(map[string]any{
			"startAt":    0,
			"maxResults": 50,
			"total":      1,
			"issues": []map[string]any{{
				"id":  "10042",
				"key": "PAY-123",
				"fields": map[string]any{
					"summary": "Fix callback",
					"updated": "2026-06-29T10:00:00.000+0800",
				},
			}},
		})
	}))
	defer server.Close()

	client := NewHTTPClient(HTTPClientConfig{HTTPClient: server.Client()})
	res, err := client.SearchIssues(context.Background(), Credentials{SiteURL: server.URL, AuthType: AuthTypePAT, Token: "pat"}, SearchIssuesRequest{
		JQL:        "project = PAY",
		StartAt:    0,
		MaxResults: 50,
		Fields:     []string{"summary", "status", "updated"},
	})
	if err != nil {
		t.Fatalf("SearchIssues returned error: %v", err)
	}
	if gotQuery.Get("jql") != "project = PAY" {
		t.Fatalf("jql = %q", gotQuery.Get("jql"))
	}
	if gotQuery.Get("fields") != "summary,status,updated" {
		t.Fatalf("fields = %q", gotQuery.Get("fields"))
	}
	if res.Total != 1 || len(res.Issues) != 1 || res.Issues[0].Key != "PAY-123" {
		t.Fatalf("unexpected search response: %#v", res)
	}
}

func TestHTTPClientReturnsSanitizedUpstreamError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "token secret-token rejected", http.StatusUnauthorized)
	}))
	defer server.Close()

	client := NewHTTPClient(HTTPClientConfig{HTTPClient: server.Client()})
	_, err := client.Myself(context.Background(), Credentials{
		SiteURL:  server.URL,
		AuthType: AuthTypePAT,
		Token:    "secret-token",
	})
	if err == nil {
		t.Fatal("expected error")
	}
	if strings.Contains(err.Error(), "secret-token") {
		t.Fatalf("error leaks token: %v", err)
	}
	if !strings.Contains(err.Error(), "401") {
		t.Fatalf("error should include status code, got %v", err)
	}
}
