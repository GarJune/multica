package jira

import "context"

const (
	AuthTypeCloudAPIToken = "cloud_api_token"
	AuthTypePAT           = "pat"
)

type Credentials struct {
	SiteURL  string
	AuthType string
	Email    string
	Token    string
}

type User struct {
	AccountID    string `json:"accountId"`
	DisplayName  string `json:"displayName"`
	EmailAddress string `json:"emailAddress"`
}

type Project struct {
	ID             string
	Key            string
	Name           string
	ProjectTypeKey string
	AvatarURL      string
}

type Issue struct {
	ID     string      `json:"id"`
	Key    string      `json:"key"`
	Self   string      `json:"self"`
	Fields IssueFields `json:"fields"`
}

type IssueFields struct {
	Summary     string         `json:"summary"`
	Description any            `json:"description"`
	Status      Status         `json:"status"`
	Priority    *Priority      `json:"priority"`
	IssueType   *IssueType     `json:"issuetype"`
	Project     *IssueProject  `json:"project"`
	Updated     string         `json:"updated"`
	Created     string         `json:"created"`
	Raw         map[string]any `json:"-"`
}

type Status struct {
	Name           string         `json:"name"`
	StatusCategory StatusCategory `json:"statusCategory"`
}

type StatusCategory struct {
	Key  string `json:"key"`
	Name string `json:"name"`
}

type Priority struct {
	Name string `json:"name"`
}

type IssueType struct {
	Name string `json:"name"`
}

type IssueProject struct {
	ID   string `json:"id"`
	Key  string `json:"key"`
	Name string `json:"name"`
}

type SearchIssuesRequest struct {
	JQL        string
	StartAt    int
	MaxResults int
	Fields     []string
}

type SearchIssuesResponse struct {
	StartAt    int     `json:"startAt"`
	MaxResults int     `json:"maxResults"`
	Total      int     `json:"total"`
	Issues     []Issue `json:"issues"`
}

type Comment struct {
	ID      string `json:"id"`
	Body    any    `json:"body"`
	Created string `json:"created"`
	Author  User   `json:"author"`
}

type Transition struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	To   Status `json:"to"`
}

type APIClient interface {
	Myself(ctx context.Context, creds Credentials) (User, error)
	ListProjects(ctx context.Context, creds Credentials) ([]Project, error)
	SearchIssues(ctx context.Context, creds Credentials, req SearchIssuesRequest) (SearchIssuesResponse, error)
	GetIssue(ctx context.Context, creds Credentials, issueIDOrKey string) (Issue, error)
	AddComment(ctx context.Context, creds Credentials, issueIDOrKey string, body string) (Comment, error)
	ListTransitions(ctx context.Context, creds Credentials, issueIDOrKey string) ([]Transition, error)
	DoTransition(ctx context.Context, creds Credentials, issueIDOrKey string, transitionID string) error
}
