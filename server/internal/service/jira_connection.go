package service

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/integrations/jira"
	"github.com/multica-ai/multica/server/internal/util/secretbox"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const defaultJiraSyncIntervalMinutes = 5

var (
	ErrJiraConnectionNotFound = errors.New("jira connection not found")
	ErrJiraInvalidConfig      = errors.New("invalid jira configuration")
)

type JiraConnectionService struct {
	Queries *db.Queries
	Client  jira.APIClient
	Box     *secretbox.Box
}

type JiraConnectionParams struct {
	WorkspaceID pgtype.UUID
	MemberID    pgtype.UUID
	SiteURL     string
	AuthType    string
	Email       string
	Token       string
}

type JiraProjectBindingParams struct {
	WorkspaceID  pgtype.UUID
	MemberID     pgtype.UUID
	ConnectionID pgtype.UUID
	ProjectID    string
	ProjectKey   string
	ProjectName  string
	SyncEnabled  bool
}

func NewJiraConnectionService(q *db.Queries, client jira.APIClient, box *secretbox.Box) *JiraConnectionService {
	return &JiraConnectionService{Queries: q, Client: client, Box: box}
}

func (s *JiraConnectionService) UpsertConnection(ctx context.Context, p JiraConnectionParams) (db.JiraConnection, error) {
	if s.Client == nil {
		return db.JiraConnection{}, fmt.Errorf("jira connection: api client is required")
	}
	if s.Box == nil {
		return db.JiraConnection{}, fmt.Errorf("jira connection: secretbox is required")
	}
	siteURL, err := normalizeJiraSiteURL(p.SiteURL)
	if err != nil {
		return db.JiraConnection{}, err
	}
	if p.Token == "" {
		return db.JiraConnection{}, fmt.Errorf("%w: token is required", ErrJiraInvalidConfig)
	}
	if p.AuthType == jira.AuthTypeCloudAPIToken && strings.TrimSpace(p.Email) == "" {
		return db.JiraConnection{}, fmt.Errorf("%w: email is required for cloud_api_token", ErrJiraInvalidConfig)
	}
	creds := jira.Credentials{SiteURL: siteURL, AuthType: p.AuthType, Email: strings.TrimSpace(p.Email), Token: p.Token}
	user, err := s.Client.Myself(ctx, creds)
	if err != nil {
		return db.JiraConnection{}, fmt.Errorf("jira connection: validate credentials: %w", err)
	}
	sealed, err := s.Box.Seal([]byte(p.Token))
	if err != nil {
		return db.JiraConnection{}, fmt.Errorf("jira connection: encrypt token: %w", err)
	}
	return s.Queries.UpsertJiraConnection(ctx, db.UpsertJiraConnectionParams{
		WorkspaceID:     p.WorkspaceID,
		MemberID:        p.MemberID,
		SiteUrl:         siteURL,
		AuthType:        p.AuthType,
		Email:           textOrNull(p.Email),
		EncryptedToken:  base64.StdEncoding.EncodeToString(sealed),
		JiraAccountID:   user.AccountID,
		JiraDisplayName: user.DisplayName,
		JiraEmail:       textOrNull(user.EmailAddress),
	})
}

func (s *JiraConnectionService) ListConnectionProjects(ctx context.Context, workspaceID, memberID, connectionID pgtype.UUID) ([]jira.Project, error) {
	conn, err := s.Queries.GetJiraConnectionInWorkspaceForMember(ctx, db.GetJiraConnectionInWorkspaceForMemberParams{
		ID: connectionID, WorkspaceID: workspaceID, MemberID: memberID,
	})
	if err != nil {
		return nil, ErrJiraConnectionNotFound
	}
	creds, err := s.credentialsFromConnection(conn)
	if err != nil {
		return nil, err
	}
	return s.Client.ListProjects(ctx, creds)
}

func (s *JiraConnectionService) UpsertProjectBinding(ctx context.Context, p JiraProjectBindingParams) (db.JiraProjectBinding, error) {
	conn, err := s.Queries.GetJiraConnectionInWorkspaceForMember(ctx, db.GetJiraConnectionInWorkspaceForMemberParams{
		ID: p.ConnectionID, WorkspaceID: p.WorkspaceID, MemberID: p.MemberID,
	})
	if err != nil {
		return db.JiraProjectBinding{}, ErrJiraConnectionNotFound
	}
	if strings.TrimSpace(p.ProjectID) == "" || strings.TrimSpace(p.ProjectKey) == "" || strings.TrimSpace(p.ProjectName) == "" {
		return db.JiraProjectBinding{}, fmt.Errorf("%w: project id, key, and name are required", ErrJiraInvalidConfig)
	}
	creds, err := s.credentialsFromConnection(conn)
	if err != nil {
		return db.JiraProjectBinding{}, err
	}
	projects, err := s.Client.ListProjects(ctx, creds)
	if err != nil {
		return db.JiraProjectBinding{}, fmt.Errorf("jira binding: validate project: %w", err)
	}
	if !jiraProjectExists(projects, p.ProjectID, p.ProjectKey) {
		return db.JiraProjectBinding{}, fmt.Errorf("%w: project is not accessible", ErrJiraInvalidConfig)
	}
	return s.Queries.UpsertJiraProjectBinding(ctx, db.UpsertJiraProjectBindingParams{
		WorkspaceID:         p.WorkspaceID,
		ConnectionID:        p.ConnectionID,
		ProjectID:           p.ProjectID,
		ProjectKey:          strings.TrimSpace(p.ProjectKey),
		ProjectName:         strings.TrimSpace(p.ProjectName),
		SyncEnabled:         pgtype.Bool{Bool: p.SyncEnabled, Valid: true},
		SyncIntervalMinutes: pgtype.Int4{Int32: defaultJiraSyncIntervalMinutes, Valid: true},
	})
}

func (s *JiraConnectionService) credentialsFromConnection(conn db.JiraConnection) (jira.Credentials, error) {
	if s.Box == nil {
		return jira.Credentials{}, fmt.Errorf("jira connection: secretbox is required")
	}
	sealed, err := base64.StdEncoding.DecodeString(conn.EncryptedToken)
	if err != nil {
		return jira.Credentials{}, fmt.Errorf("jira connection: decode token: %w", err)
	}
	plain, err := s.Box.Open(sealed)
	if err != nil {
		return jira.Credentials{}, fmt.Errorf("jira connection: decrypt token: %w", err)
	}
	return jira.Credentials{
		SiteURL:  conn.SiteUrl,
		AuthType: conn.AuthType,
		Email:    conn.Email.String,
		Token:    string(plain),
	}, nil
}

func normalizeJiraSiteURL(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", fmt.Errorf("%w: site_url must be a valid URL", ErrJiraInvalidConfig)
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		return "", fmt.Errorf("%w: site_url must use http or https", ErrJiraInvalidConfig)
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return strings.TrimRight(parsed.String(), "/"), nil
}

func textOrNull(s string) pgtype.Text {
	trimmed := strings.TrimSpace(s)
	if trimmed == "" {
		return pgtype.Text{}
	}
	return pgtype.Text{String: trimmed, Valid: true}
}

func jiraProjectExists(projects []jira.Project, id, key string) bool {
	for _, project := range projects {
		if project.ID == id && project.Key == key {
			return true
		}
	}
	return false
}
