package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/integrations/jira"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const (
	JiraSyncRunScheduled = "scheduled"
	JiraSyncRunManual    = "manual"
)

var ErrJiraIssueNotSynced = errors.New("issue is not synced from jira")

type JiraSyncService struct {
	Queries           *db.Queries
	IssueService      *IssueService
	ConnectionService *JiraConnectionService
	Client            jira.APIClient
	Now               func() time.Time
}

type JiraSyncResult struct {
	Run     db.JiraSyncRun
	Created int32
	Updated int32
	Skipped int32
	Seen    int32
}

type JiraUpsertInput struct {
	WorkspaceID    pgtype.UUID
	Connection     db.JiraConnection
	ProjectBinding db.JiraProjectBinding
	MemberID       pgtype.UUID
	Issue          jira.Issue
}

type JiraUpsertResult struct {
	Issue   db.Issue
	Mapping db.JiraIssueMapping
	Action  string
}

func NewJiraSyncService(q *db.Queries, issueSvc *IssueService, connSvc *JiraConnectionService, client jira.APIClient) *JiraSyncService {
	return &JiraSyncService{Queries: q, IssueService: issueSvc, ConnectionService: connSvc, Client: client, Now: time.Now}
}

func (s *JiraSyncService) RunBindingSync(ctx context.Context, bindingID pgtype.UUID, runType string) (JiraSyncResult, error) {
	now := s.now()
	binding, err := s.Queries.GetJiraProjectBinding(ctx, bindingID)
	if err != nil {
		return JiraSyncResult{}, fmt.Errorf("jira sync: load binding: %w", err)
	}
	run, err := s.Queries.CreateJiraSyncRun(ctx, db.CreateJiraSyncRunParams{
		WorkspaceID:      binding.WorkspaceID,
		ProjectBindingID: binding.ID,
		RunType:          runType,
		StartedAt:        pgtype.Timestamptz{Time: now, Valid: true},
	})
	if err != nil {
		return JiraSyncResult{}, fmt.Errorf("jira sync: create run: %w", err)
	}
	_, _ = s.Queries.UpdateJiraProjectBindingSyncStarted(ctx, db.UpdateJiraProjectBindingSyncStartedParams{ID: binding.ID, LastSyncAt: pgtype.Timestamptz{Time: now, Valid: true}})

	result, syncErr := s.runBindingSync(ctx, binding, run)
	finishedAt := s.now()
	status := "success"
	var errText pgtype.Text
	if syncErr != nil {
		status = "failed"
		errText = pgtype.Text{String: sanitizeJiraError(syncErr), Valid: true}
	}
	finished, finishErr := s.Queries.FinishJiraSyncRun(ctx, db.FinishJiraSyncRunParams{
		ID:            run.ID,
		Status:        status,
		FinishedAt:    pgtype.Timestamptz{Time: finishedAt, Valid: true},
		IssuesSeen:    result.Seen,
		IssuesCreated: result.Created,
		IssuesUpdated: result.Updated,
		IssuesSkipped: result.Skipped,
		ErrorMessage:  errText,
	})
	if finishErr != nil && syncErr == nil {
		return JiraSyncResult{}, fmt.Errorf("jira sync: finish run: %w", finishErr)
	}
	result.Run = finished
	if syncErr != nil {
		_, _ = s.Queries.UpdateJiraProjectBindingSyncFailed(ctx, db.UpdateJiraProjectBindingSyncFailedParams{ID: binding.ID, LastError: errText})
		return result, syncErr
	}
	_, err = s.Queries.UpdateJiraProjectBindingSyncSucceeded(ctx, db.UpdateJiraProjectBindingSyncSucceededParams{ID: binding.ID, LastSuccessfulSyncAt: pgtype.Timestamptz{Time: finishedAt, Valid: true}})
	if err != nil {
		return result, fmt.Errorf("jira sync: update cursor: %w", err)
	}
	return result, nil
}

func (s *JiraSyncService) runBindingSync(ctx context.Context, binding db.JiraProjectBinding, run db.JiraSyncRun) (JiraSyncResult, error) {
	conn, err := s.Queries.GetJiraConnectionInWorkspace(ctx, db.GetJiraConnectionInWorkspaceParams{ID: binding.ConnectionID, WorkspaceID: binding.WorkspaceID})
	if err != nil {
		return JiraSyncResult{}, fmt.Errorf("jira sync: load connection: %w", err)
	}
	creds, err := s.ConnectionService.credentialsFromConnection(conn)
	if err != nil {
		return JiraSyncResult{}, err
	}
	jql := buildJiraSyncJQL(binding.ProjectKey, timestamptzTime(binding.LastSuccessfulSyncAt))
	startAt := 0
	maxResults := 50
	out := JiraSyncResult{Run: run}
	for {
		page, err := s.Client.SearchIssues(ctx, creds, jira.SearchIssuesRequest{
			JQL:        jql,
			StartAt:    startAt,
			MaxResults: maxResults,
			Fields:     []string{"summary", "description", "status", "priority", "issuetype", "project", "updated", "created"},
		})
		if err != nil {
			return out, fmt.Errorf("jira sync: search issues: %w", err)
		}
		for _, issue := range page.Issues {
			out.Seen++
			res, err := s.UpsertIssueFromJira(ctx, JiraUpsertInput{WorkspaceID: binding.WorkspaceID, Connection: conn, ProjectBinding: binding, MemberID: conn.MemberID, Issue: issue})
			if err != nil {
				return out, err
			}
			switch res.Action {
			case "created":
				out.Created++
			case "updated":
				out.Updated++
			default:
				out.Skipped++
			}
		}
		startAt += len(page.Issues)
		if len(page.Issues) == 0 || startAt >= page.Total {
			break
		}
	}
	return out, nil
}

func (s *JiraSyncService) UpsertIssueFromJira(ctx context.Context, in JiraUpsertInput) (JiraUpsertResult, error) {
	if in.Issue.ID == "" || in.Issue.Key == "" || in.Issue.Fields.Summary == "" {
		return JiraUpsertResult{}, fmt.Errorf("jira sync: issue id, key, and summary are required")
	}
	jiraUpdatedAt, err := parseJiraTime(in.Issue.Fields.Updated)
	if err != nil {
		return JiraUpsertResult{}, fmt.Errorf("jira sync: parse updated time: %w", err)
	}
	mapping, err := s.Queries.GetJiraIssueMappingByJiraID(ctx, db.GetJiraIssueMappingByJiraIDParams{
		WorkspaceID: in.WorkspaceID, ConnectionID: in.Connection.ID, JiraIssueID: in.Issue.ID,
	})
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return JiraUpsertResult{}, fmt.Errorf("jira sync: load mapping: %w", err)
	}
	status := jira.MapStatus(in.Issue.Fields.Status)
	if errors.Is(err, pgx.ErrNoRows) {
		if status == "done" {
			return JiraUpsertResult{Action: "skipped"}, nil
		}
		return s.createMirrorIssue(ctx, in, jiraUpdatedAt)
	}
	if mapping.JiraUpdatedAt.Valid && !jiraUpdatedAt.After(mapping.JiraUpdatedAt.Time) {
		return JiraUpsertResult{Mapping: mapping, Action: "skipped"}, nil
	}
	return s.updateMirrorIssue(ctx, in, mapping, jiraUpdatedAt)
}

func (s *JiraSyncService) createMirrorIssue(ctx context.Context, in JiraUpsertInput, jiraUpdatedAt time.Time) (JiraUpsertResult, error) {
	mappingUUID, err := uuid.NewRandom()
	if err != nil {
		return JiraUpsertResult{}, fmt.Errorf("jira sync: generate mapping id: %w", err)
	}
	mappingID := pgtype.UUID{Bytes: mappingUUID, Valid: true}
	metadata := jiraMetadata(in.Connection.SiteUrl, in.Issue)
	metadataBytes, err := json.Marshal(metadata)
	if err != nil {
		return JiraUpsertResult{}, fmt.Errorf("jira sync: marshal metadata: %w", err)
	}
	description := jira.DescriptionToText(in.Issue.Fields.Description)
	created, err := s.IssueService.Create(ctx, IssueCreateParams{
		WorkspaceID:    in.WorkspaceID,
		Title:          in.Issue.Fields.Summary,
		Description:    pgtype.Text{String: description, Valid: description != ""},
		Status:         jira.MapStatus(in.Issue.Fields.Status),
		Priority:       jira.MapPriority(in.Issue.Fields.Priority),
		AssigneeType:   pgtype.Text{String: "member", Valid: true},
		AssigneeID:     in.MemberID,
		CreatorType:    "member",
		CreatorID:      in.MemberID,
		OriginType:     pgtype.Text{String: "jira", Valid: true},
		OriginID:       mappingID,
		AllowDuplicate: true,
	}, IssueCreateOpts{SuppressEnqueue: true, Platform: "jira"})
	if err != nil {
		return JiraUpsertResult{}, fmt.Errorf("jira sync: create issue: %w", err)
	}
	_, err = s.Queries.UpdateJiraMirrorIssue(ctx, db.UpdateJiraMirrorIssueParams{
		ID:          created.Issue.ID,
		WorkspaceID: in.WorkspaceID,
		Title:       created.Issue.Title,
		Description: created.Issue.Description,
		Status:      created.Issue.Status,
		Priority:    created.Issue.Priority,
		Metadata:    metadataBytes,
	})
	if err != nil {
		return JiraUpsertResult{}, fmt.Errorf("jira sync: set mirror metadata: %w", err)
	}
	mapping, err := s.Queries.CreateJiraIssueMapping(ctx, db.CreateJiraIssueMappingParams{
		ID:                 mappingID,
		WorkspaceID:        in.WorkspaceID,
		ConnectionID:       in.Connection.ID,
		ProjectBindingID:   in.ProjectBinding.ID,
		LocalIssueID:       created.Issue.ID,
		JiraIssueID:        in.Issue.ID,
		JiraKey:            in.Issue.Key,
		JiraProjectID:      textOrNull(issueProjectID(in.Issue)),
		JiraProjectKey:     issueProjectKey(in.Issue),
		JiraStatusName:     textOrNull(in.Issue.Fields.Status.Name),
		JiraStatusCategory: textOrNull(in.Issue.Fields.Status.StatusCategory.Key),
		JiraIssueType:      textOrNull(issueTypeName(in.Issue)),
		JiraPriorityName:   textOrNull(priorityName(in.Issue.Fields.Priority)),
		JiraUpdatedAt:      pgtype.Timestamptz{Time: jiraUpdatedAt, Valid: true},
		LastSyncedAt:       pgtype.Timestamptz{Time: s.now(), Valid: true},
		RawFields:          metadataBytes,
	})
	if err != nil {
		return JiraUpsertResult{}, fmt.Errorf("jira sync: create mapping: %w", err)
	}
	return JiraUpsertResult{Issue: created.Issue, Mapping: mapping, Action: "created"}, nil
}

func (s *JiraSyncService) updateMirrorIssue(ctx context.Context, in JiraUpsertInput, mapping db.JiraIssueMapping, jiraUpdatedAt time.Time) (JiraUpsertResult, error) {
	metadata := jiraMetadata(in.Connection.SiteUrl, in.Issue)
	metadataBytes, err := json.Marshal(metadata)
	if err != nil {
		return JiraUpsertResult{}, fmt.Errorf("jira sync: marshal metadata: %w", err)
	}
	description := jira.DescriptionToText(in.Issue.Fields.Description)
	updated, err := s.Queries.UpdateJiraMirrorIssue(ctx, db.UpdateJiraMirrorIssueParams{
		ID:          mapping.LocalIssueID,
		WorkspaceID: in.WorkspaceID,
		Title:       in.Issue.Fields.Summary,
		Description: pgtype.Text{String: description, Valid: description != ""},
		Status:      jira.MapStatus(in.Issue.Fields.Status),
		Priority:    jira.MapPriority(in.Issue.Fields.Priority),
		Metadata:    metadataBytes,
	})
	if err != nil {
		return JiraUpsertResult{}, fmt.Errorf("jira sync: update mirror issue: %w", err)
	}
	updatedMapping, err := s.Queries.UpdateJiraIssueMapping(ctx, db.UpdateJiraIssueMappingParams{
		ID:                 mapping.ID,
		JiraKey:            in.Issue.Key,
		JiraProjectID:      textOrNull(issueProjectID(in.Issue)),
		JiraProjectKey:     issueProjectKey(in.Issue),
		JiraStatusName:     textOrNull(in.Issue.Fields.Status.Name),
		JiraStatusCategory: textOrNull(in.Issue.Fields.Status.StatusCategory.Key),
		JiraIssueType:      textOrNull(issueTypeName(in.Issue)),
		JiraPriorityName:   textOrNull(priorityName(in.Issue.Fields.Priority)),
		JiraUpdatedAt:      pgtype.Timestamptz{Time: jiraUpdatedAt, Valid: true},
		LastSyncedAt:       pgtype.Timestamptz{Time: s.now(), Valid: true},
		RawFields:          metadataBytes,
	})
	if err != nil {
		return JiraUpsertResult{}, fmt.Errorf("jira sync: update mapping: %w", err)
	}
	return JiraUpsertResult{Issue: updated, Mapping: updatedMapping, Action: "updated"}, nil
}

func buildJiraSyncJQL(projectKey string, lastSuccessfulSyncAt time.Time) string {
	project := strings.TrimSpace(projectKey)
	if lastSuccessfulSyncAt.IsZero() {
		return fmt.Sprintf("project = %s AND assignee = currentUser() AND statusCategory != Done ORDER BY updated ASC", project)
	}
	since := lastSuccessfulSyncAt.Add(-5 * time.Minute).UTC().Format("2006-01-02 15:04")
	return fmt.Sprintf("project = %s AND assignee = currentUser() AND updated >= \"%s\" ORDER BY updated ASC", project, since)
}

func parseJiraTime(raw string) (time.Time, error) {
	for _, layout := range []string{"2006-01-02T15:04:05.000-0700", time.RFC3339, time.RFC3339Nano} {
		if parsed, err := time.Parse(layout, raw); err == nil {
			return parsed.UTC(), nil
		}
	}
	return time.Time{}, fmt.Errorf("unsupported Jira time %q", raw)
}

func (s *JiraSyncService) now() time.Time {
	if s.Now != nil {
		return s.Now().UTC()
	}
	return time.Now().UTC()
}

func timestamptzTime(value pgtype.Timestamptz) time.Time {
	if !value.Valid {
		return time.Time{}
	}
	return value.Time.UTC()
}

func jiraMetadata(siteURL string, issue jira.Issue) map[string]any {
	metadata := map[string]any{
		"source":             "jira",
		"jiraKey":            issue.Key,
		"jiraUrl":            strings.TrimRight(siteURL, "/") + "/browse/" + issue.Key,
		"jiraStatusName":     issue.Fields.Status.Name,
		"jiraStatusCategory": issue.Fields.Status.StatusCategory.Key,
	}
	if projectKey := issueProjectKey(issue); projectKey != "" {
		metadata["jiraProjectKey"] = projectKey
	}
	if issueType := issueTypeName(issue); issueType != "" {
		metadata["jiraIssueType"] = issueType
	}
	if priority := priorityName(issue.Fields.Priority); priority != "" {
		metadata["jiraPriorityName"] = priority
	}
	return metadata
}

func issueProjectID(issue jira.Issue) string {
	if issue.Fields.Project == nil {
		return ""
	}
	return issue.Fields.Project.ID
}

func issueProjectKey(issue jira.Issue) string {
	if issue.Fields.Project == nil {
		return ""
	}
	return issue.Fields.Project.Key
}

func issueTypeName(issue jira.Issue) string {
	if issue.Fields.IssueType == nil {
		return ""
	}
	return issue.Fields.IssueType.Name
}

func priorityName(priority *jira.Priority) string {
	if priority == nil {
		return ""
	}
	return priority.Name
}

func sanitizeJiraError(err error) string {
	msg := err.Error()
	if len(msg) > 512 {
		return msg[:512]
	}
	return msg
}
