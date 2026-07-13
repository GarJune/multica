package service

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/integrations/jira"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type JiraActionService struct {
	Queries           *db.Queries
	ConnectionService *JiraConnectionService
	SyncService       *JiraSyncService
	Client            jira.APIClient
}

type JiraCommentResult struct {
	Comment     db.Comment
	JiraComment jira.Comment
	Issue       db.Issue
}

func NewJiraActionService(q *db.Queries, connSvc *JiraConnectionService, syncSvc *JiraSyncService, client jira.APIClient) *JiraActionService {
	return &JiraActionService{Queries: q, ConnectionService: connSvc, SyncService: syncSvc, Client: client}
}

func (s *JiraActionService) AddComment(ctx context.Context, issue db.Issue, actorID pgtype.UUID, body string) (JiraCommentResult, error) {
	body = strings.TrimSpace(body)
	if body == "" {
		return JiraCommentResult{}, fmt.Errorf("jira action: comment body is required")
	}
	mapping, conn, binding, creds, err := s.loadActionContext(ctx, issue)
	if err != nil {
		return JiraCommentResult{}, err
	}
	jiraComment, err := s.Client.AddComment(ctx, creds, mapping.JiraIssueID, body)
	if err != nil {
		return JiraCommentResult{}, fmt.Errorf("jira action: add comment: %w", err)
	}
	comment, err := s.Queries.CreateComment(ctx, db.CreateCommentParams{
		IssueID:     issue.ID,
		WorkspaceID: issue.WorkspaceID,
		AuthorType:  "member",
		AuthorID:    actorID,
		Content:     body,
		Type:        "comment",
	})
	if err != nil {
		return JiraCommentResult{}, fmt.Errorf("jira action: create local comment: %w", err)
	}
	refreshed, err := s.refreshIssue(ctx, conn, binding, mapping)
	if err != nil {
		return JiraCommentResult{Comment: comment, JiraComment: jiraComment}, err
	}
	return JiraCommentResult{Comment: comment, JiraComment: jiraComment, Issue: refreshed}, nil
}

func (s *JiraActionService) ListTransitions(ctx context.Context, issue db.Issue) ([]jira.Transition, error) {
	mapping, _, _, creds, err := s.loadActionContext(ctx, issue)
	if err != nil {
		return nil, err
	}
	transitions, err := s.Client.ListTransitions(ctx, creds, mapping.JiraIssueID)
	if err != nil {
		return nil, fmt.Errorf("jira action: list transitions: %w", err)
	}
	return transitions, nil
}

func (s *JiraActionService) DoTransition(ctx context.Context, issue db.Issue, transitionID string) (db.Issue, error) {
	transitionID = strings.TrimSpace(transitionID)
	if transitionID == "" {
		return db.Issue{}, fmt.Errorf("jira action: transition_id is required")
	}
	mapping, conn, binding, creds, err := s.loadActionContext(ctx, issue)
	if err != nil {
		return db.Issue{}, err
	}
	if err := s.Client.DoTransition(ctx, creds, mapping.JiraIssueID, transitionID); err != nil {
		return db.Issue{}, fmt.Errorf("jira action: transition issue: %w", err)
	}
	return s.refreshIssue(ctx, conn, binding, mapping)
}

func (s *JiraActionService) loadActionContext(ctx context.Context, issue db.Issue) (db.JiraIssueMapping, db.JiraConnection, db.JiraProjectBinding, jira.Credentials, error) {
	if !issue.OriginType.Valid || issue.OriginType.String != "jira" {
		return db.JiraIssueMapping{}, db.JiraConnection{}, db.JiraProjectBinding{}, jira.Credentials{}, ErrJiraIssueNotSynced
	}
	mapping, err := s.Queries.GetJiraIssueMappingByIssueID(ctx, db.GetJiraIssueMappingByIssueIDParams{WorkspaceID: issue.WorkspaceID, LocalIssueID: issue.ID})
	if err != nil {
		return db.JiraIssueMapping{}, db.JiraConnection{}, db.JiraProjectBinding{}, jira.Credentials{}, fmt.Errorf("jira action: load mapping: %w", err)
	}
	conn, err := s.Queries.GetJiraConnectionInWorkspace(ctx, db.GetJiraConnectionInWorkspaceParams{ID: mapping.ConnectionID, WorkspaceID: issue.WorkspaceID})
	if err != nil {
		return db.JiraIssueMapping{}, db.JiraConnection{}, db.JiraProjectBinding{}, jira.Credentials{}, fmt.Errorf("jira action: load connection: %w", err)
	}
	binding, err := s.Queries.GetJiraProjectBinding(ctx, mapping.ProjectBindingID)
	if err != nil {
		return db.JiraIssueMapping{}, db.JiraConnection{}, db.JiraProjectBinding{}, jira.Credentials{}, fmt.Errorf("jira action: load binding: %w", err)
	}
	creds, err := s.ConnectionService.credentialsFromConnection(conn)
	if err != nil {
		return db.JiraIssueMapping{}, db.JiraConnection{}, db.JiraProjectBinding{}, jira.Credentials{}, err
	}
	return mapping, conn, binding, creds, nil
}

func (s *JiraActionService) refreshIssue(ctx context.Context, conn db.JiraConnection, binding db.JiraProjectBinding, mapping db.JiraIssueMapping) (db.Issue, error) {
	creds, err := s.ConnectionService.credentialsFromConnection(conn)
	if err != nil {
		return db.Issue{}, err
	}
	jiraIssue, err := s.Client.GetIssue(ctx, creds, mapping.JiraIssueID)
	if err != nil {
		return db.Issue{}, fmt.Errorf("jira action: refresh issue: %w", err)
	}
	res, err := s.SyncService.UpsertIssueFromJira(ctx, JiraUpsertInput{
		WorkspaceID:    mapping.WorkspaceID,
		Connection:     conn,
		ProjectBinding: binding,
		MemberID:       conn.MemberID,
		Issue:          jiraIssue,
	})
	if err != nil {
		return db.Issue{}, err
	}
	if !res.Issue.ID.Valid {
		return db.Issue{}, errors.New("jira action: refresh did not return issue")
	}
	return res.Issue, nil
}
