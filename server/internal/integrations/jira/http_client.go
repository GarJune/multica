package jira

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const defaultHTTPTimeout = 10 * time.Second

type HTTPClientConfig struct {
	HTTPClient *http.Client
}

func NewHTTPClient(cfg HTTPClientConfig) APIClient {
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: defaultHTTPTimeout}
	}
	return &httpClient{httpClient: cfg.HTTPClient}
}

type httpClient struct {
	httpClient *http.Client
}

func (c *httpClient) Myself(ctx context.Context, creds Credentials) (User, error) {
	var out User
	if err := c.doJSON(ctx, creds, http.MethodGet, "/rest/api/3/myself", nil, &out); err != nil {
		return User{}, err
	}
	return out, nil
}

func (c *httpClient) ListProjects(ctx context.Context, creds Credentials) ([]Project, error) {
	var resp struct {
		Values []struct {
			ID             string            `json:"id"`
			Key            string            `json:"key"`
			Name           string            `json:"name"`
			ProjectTypeKey string            `json:"projectTypeKey"`
			AvatarURLs     map[string]string `json:"avatarUrls"`
		} `json:"values"`
	}
	if err := c.doJSON(ctx, creds, http.MethodGet, "/rest/api/3/project/search", nil, &resp); err != nil {
		return nil, err
	}
	projects := make([]Project, 0, len(resp.Values))
	for _, p := range resp.Values {
		projects = append(projects, Project{
			ID:             p.ID,
			Key:            p.Key,
			Name:           p.Name,
			ProjectTypeKey: p.ProjectTypeKey,
			AvatarURL:      firstAvatarURL(p.AvatarURLs),
		})
	}
	return projects, nil
}

func (c *httpClient) SearchIssues(ctx context.Context, creds Credentials, req SearchIssuesRequest) (SearchIssuesResponse, error) {
	q := url.Values{}
	q.Set("jql", req.JQL)
	if req.MaxResults > 0 {
		q.Set("maxResults", fmt.Sprintf("%d", req.MaxResults))
	}
	if req.StartAt > 0 {
		q.Set("startAt", fmt.Sprintf("%d", req.StartAt))
	}
	if len(req.Fields) > 0 {
		q.Set("fields", strings.Join(req.Fields, ","))
	}
	path := "/rest/api/3/search?" + q.Encode()
	var out SearchIssuesResponse
	if err := c.doJSON(ctx, creds, http.MethodGet, path, nil, &out); err != nil {
		return SearchIssuesResponse{}, err
	}
	return out, nil
}

func (c *httpClient) GetIssue(ctx context.Context, creds Credentials, issueIDOrKey string) (Issue, error) {
	var out Issue
	if err := c.doJSON(ctx, creds, http.MethodGet, "/rest/api/3/issue/"+url.PathEscape(issueIDOrKey), nil, &out); err != nil {
		return Issue{}, err
	}
	return out, nil
}

func (c *httpClient) AddComment(ctx context.Context, creds Credentials, issueIDOrKey string, body string) (Comment, error) {
	payload := map[string]any{"body": body}
	var out Comment
	if err := c.doJSON(ctx, creds, http.MethodPost, "/rest/api/3/issue/"+url.PathEscape(issueIDOrKey)+"/comment", payload, &out); err != nil {
		return Comment{}, err
	}
	return out, nil
}

func (c *httpClient) ListTransitions(ctx context.Context, creds Credentials, issueIDOrKey string) ([]Transition, error) {
	var resp struct {
		Transitions []Transition `json:"transitions"`
	}
	if err := c.doJSON(ctx, creds, http.MethodGet, "/rest/api/3/issue/"+url.PathEscape(issueIDOrKey)+"/transitions", nil, &resp); err != nil {
		return nil, err
	}
	return resp.Transitions, nil
}

func (c *httpClient) DoTransition(ctx context.Context, creds Credentials, issueIDOrKey string, transitionID string) error {
	payload := map[string]any{"transition": map[string]string{"id": transitionID}}
	return c.doJSON(ctx, creds, http.MethodPost, "/rest/api/3/issue/"+url.PathEscape(issueIDOrKey)+"/transitions", payload, nil)
}

func (c *httpClient) doJSON(ctx context.Context, creds Credentials, method string, path string, body any, out any) error {
	baseURL := strings.TrimRight(creds.SiteURL, "/")
	if baseURL == "" {
		return fmt.Errorf("jira: site_url is required")
	}
	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("jira: encode request: %w", err)
		}
		reader = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, baseURL+path, reader)
	if err != nil {
		return fmt.Errorf("jira: build request: %w", err)
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if err := applyAuth(req, creds); err != nil {
		return err
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("jira: request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("jira: upstream returned %d %s", resp.StatusCode, http.StatusText(resp.StatusCode))
	}
	if out == nil {
		_, _ = io.Copy(io.Discard, resp.Body)
		return nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return fmt.Errorf("jira: decode response: %w", err)
	}
	return nil
}

func applyAuth(req *http.Request, creds Credentials) error {
	switch creds.AuthType {
	case AuthTypeCloudAPIToken:
		if creds.Email == "" {
			return fmt.Errorf("jira: email is required for cloud_api_token auth")
		}
		if creds.Token == "" {
			return fmt.Errorf("jira: token is required")
		}
		encoded := base64.StdEncoding.EncodeToString([]byte(creds.Email + ":" + creds.Token))
		req.Header.Set("Authorization", "Basic "+encoded)
		return nil
	case AuthTypePAT:
		if creds.Token == "" {
			return fmt.Errorf("jira: token is required")
		}
		req.Header.Set("Authorization", "Bearer "+creds.Token)
		return nil
	default:
		return fmt.Errorf("jira: unsupported auth_type %q", creds.AuthType)
	}
}

func firstAvatarURL(values map[string]string) string {
	for _, key := range []string{"48x48", "32x32", "24x24", "16x16"} {
		if values[key] != "" {
			return values[key]
		}
	}
	return ""
}
