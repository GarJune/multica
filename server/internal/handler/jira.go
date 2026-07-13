package handler

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/multica-ai/multica/server/internal/integrations/jira"
	"github.com/multica-ai/multica/server/internal/service"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

type JiraConnectionResponse struct {
	ID              string  `json:"id"`
	WorkspaceID     string  `json:"workspace_id"`
	MemberID        string  `json:"member_id"`
	SiteURL         string  `json:"site_url"`
	AuthType        string  `json:"auth_type"`
	Email           *string `json:"email"`
	JiraAccountID   string  `json:"jira_account_id"`
	JiraDisplayName string  `json:"jira_display_name"`
	JiraEmail       *string `json:"jira_email"`
	CreatedAt       string  `json:"created_at"`
	UpdatedAt       string  `json:"updated_at"`
}

type JiraProjectResponse struct {
	ID             string `json:"id"`
	Key            string `json:"key"`
	Name           string `json:"name"`
	ProjectTypeKey string `json:"project_type_key"`
	AvatarURL      string `json:"avatar_url"`
}

type JiraProjectBindingResponse struct {
	ID                   string  `json:"id"`
	WorkspaceID          string  `json:"workspace_id"`
	ConnectionID         string  `json:"connection_id"`
	ProjectID            string  `json:"project_id"`
	ProjectKey           string  `json:"project_key"`
	ProjectName          string  `json:"project_name"`
	SyncEnabled          bool    `json:"sync_enabled"`
	SyncIntervalMinutes  int32   `json:"sync_interval_minutes"`
	LastSyncAt           *string `json:"last_sync_at"`
	LastSuccessfulSyncAt *string `json:"last_successful_sync_at"`
	LastError            *string `json:"last_error"`
	CreatedAt            string  `json:"created_at"`
	UpdatedAt            string  `json:"updated_at"`
}

type JiraSyncRunResponse struct {
	ID               string  `json:"id"`
	WorkspaceID      string  `json:"workspace_id"`
	ProjectBindingID string  `json:"project_binding_id"`
	RunType          string  `json:"run_type"`
	Status           string  `json:"status"`
	StartedAt        string  `json:"started_at"`
	FinishedAt       *string `json:"finished_at"`
	IssuesSeen       int32   `json:"issues_seen"`
	IssuesCreated    int32   `json:"issues_created"`
	IssuesUpdated    int32   `json:"issues_updated"`
	IssuesSkipped    int32   `json:"issues_skipped"`
	ErrorMessage     *string `json:"error_message"`
}

type JiraTransitionResponse struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	ToStatusName     string `json:"to_status_name"`
	ToStatusCategory string `json:"to_status_category"`
}

type JiraCommentResponse struct {
	JiraCommentID     string `json:"jira_comment_id"`
	Body              string `json:"body"`
	CreatedAt         string `json:"created_at"`
	AuthorDisplayName string `json:"author_display_name"`
}

func jiraConnectionToResponse(row db.JiraConnection) JiraConnectionResponse {
	return JiraConnectionResponse{
		ID:              uuidToString(row.ID),
		WorkspaceID:     uuidToString(row.WorkspaceID),
		MemberID:        uuidToString(row.MemberID),
		SiteURL:         row.SiteUrl,
		AuthType:        row.AuthType,
		Email:           textToPtr(row.Email),
		JiraAccountID:   row.JiraAccountID,
		JiraDisplayName: row.JiraDisplayName,
		JiraEmail:       textToPtr(row.JiraEmail),
		CreatedAt:       timestampToString(row.CreatedAt),
		UpdatedAt:       timestampToString(row.UpdatedAt),
	}
}

func jiraProjectToResponse(project jira.Project) JiraProjectResponse {
	return JiraProjectResponse{ID: project.ID, Key: project.Key, Name: project.Name, ProjectTypeKey: project.ProjectTypeKey, AvatarURL: project.AvatarURL}
}

func jiraBindingToResponse(row db.JiraProjectBinding) JiraProjectBindingResponse {
	return JiraProjectBindingResponse{
		ID:                   uuidToString(row.ID),
		WorkspaceID:          uuidToString(row.WorkspaceID),
		ConnectionID:         uuidToString(row.ConnectionID),
		ProjectID:            row.ProjectID,
		ProjectKey:           row.ProjectKey,
		ProjectName:          row.ProjectName,
		SyncEnabled:          row.SyncEnabled,
		SyncIntervalMinutes:  row.SyncIntervalMinutes,
		LastSyncAt:           timestampToPtr(row.LastSyncAt),
		LastSuccessfulSyncAt: timestampToPtr(row.LastSuccessfulSyncAt),
		LastError:            textToPtr(row.LastError),
		CreatedAt:            timestampToString(row.CreatedAt),
		UpdatedAt:            timestampToString(row.UpdatedAt),
	}
}

func jiraSyncRunToResponse(row db.JiraSyncRun) JiraSyncRunResponse {
	return JiraSyncRunResponse{
		ID:               uuidToString(row.ID),
		WorkspaceID:      uuidToString(row.WorkspaceID),
		ProjectBindingID: uuidToString(row.ProjectBindingID),
		RunType:          row.RunType,
		Status:           row.Status,
		StartedAt:        timestampToString(row.StartedAt),
		FinishedAt:       timestampToPtr(row.FinishedAt),
		IssuesSeen:       row.IssuesSeen,
		IssuesCreated:    row.IssuesCreated,
		IssuesUpdated:    row.IssuesUpdated,
		IssuesSkipped:    row.IssuesSkipped,
		ErrorMessage:     textToPtr(row.ErrorMessage),
	}
}

func (h *Handler) jiraEnabled(w http.ResponseWriter) bool {
	if h.JiraConnections == nil || h.JiraSync == nil || h.JiraActions == nil {
		writeError(w, http.StatusServiceUnavailable, "jira integration is not configured")
		return false
	}
	return true
}

func (h *Handler) CreateJiraConnection(w http.ResponseWriter, r *http.Request) {
	if !h.jiraEnabled(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	member, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}
	var req struct {
		SiteURL  string `json:"site_url"`
		AuthType string `json:"auth_type"`
		Email    string `json:"email"`
		Token    string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	conn, err := h.JiraConnections.UpsertConnection(r.Context(), service.JiraConnectionParams{
		WorkspaceID: member.WorkspaceID,
		MemberID:    member.UserID,
		SiteURL:     req.SiteURL,
		AuthType:    req.AuthType,
		Email:       req.Email,
		Token:       req.Token,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"connection": jiraConnectionToResponse(conn)})
}

func (h *Handler) ListJiraConnections(w http.ResponseWriter, r *http.Request) {
	if !h.jiraEnabled(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	member, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}
	rows, err := h.Queries.ListJiraConnectionsForMember(r.Context(), db.ListJiraConnectionsForMemberParams{WorkspaceID: member.WorkspaceID, MemberID: member.UserID})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list jira connections")
		return
	}
	out := make([]JiraConnectionResponse, 0, len(rows))
	for _, row := range rows {
		out = append(out, jiraConnectionToResponse(row))
	}
	writeJSON(w, http.StatusOK, map[string]any{"connections": out})
}

func (h *Handler) ListJiraConnectionProjects(w http.ResponseWriter, r *http.Request) {
	if !h.jiraEnabled(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	member, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}
	connectionID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "connectionID"), "connection id")
	if !ok {
		return
	}
	projects, err := h.JiraConnections.ListConnectionProjects(r.Context(), member.WorkspaceID, member.UserID, connectionID)
	if err != nil {
		writeError(w, http.StatusBadGateway, "failed to load jira projects")
		return
	}
	out := make([]JiraProjectResponse, 0, len(projects))
	for _, project := range projects {
		out = append(out, jiraProjectToResponse(project))
	}
	writeJSON(w, http.StatusOK, map[string]any{"projects": out})
}

func (h *Handler) CreateJiraProjectBinding(w http.ResponseWriter, r *http.Request) {
	if !h.jiraEnabled(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	member, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}
	var req struct {
		ConnectionID string `json:"connection_id"`
		ProjectID    string `json:"project_id"`
		ProjectKey   string `json:"project_key"`
		ProjectName  string `json:"project_name"`
		SyncEnabled  *bool  `json:"sync_enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	connectionID, ok := parseUUIDOrBadRequest(w, req.ConnectionID, "connection_id")
	if !ok {
		return
	}
	syncEnabled := true
	if req.SyncEnabled != nil {
		syncEnabled = *req.SyncEnabled
	}
	binding, err := h.JiraConnections.UpsertProjectBinding(r.Context(), service.JiraProjectBindingParams{
		WorkspaceID:  member.WorkspaceID,
		MemberID:     member.UserID,
		ConnectionID: connectionID,
		ProjectID:    req.ProjectID,
		ProjectKey:   req.ProjectKey,
		ProjectName:  req.ProjectName,
		SyncEnabled:  syncEnabled,
	})
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"binding": jiraBindingToResponse(binding)})
}

func (h *Handler) ListJiraProjectBindings(w http.ResponseWriter, r *http.Request) {
	if !h.jiraEnabled(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	member, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}
	rows, err := h.Queries.ListJiraProjectBindingsForMember(r.Context(), db.ListJiraProjectBindingsForMemberParams{WorkspaceID: member.WorkspaceID, MemberID: member.UserID})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list jira project bindings")
		return
	}
	out := make([]JiraProjectBindingResponse, 0, len(rows))
	for _, row := range rows {
		out = append(out, jiraBindingToResponse(row))
	}
	writeJSON(w, http.StatusOK, map[string]any{"bindings": out})
}

func (h *Handler) SyncJiraProjectBinding(w http.ResponseWriter, r *http.Request) {
	if !h.jiraEnabled(w) {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	member, ok := h.workspaceMember(w, r, workspaceID)
	if !ok {
		return
	}
	bindingID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "bindingID"), "binding id")
	if !ok {
		return
	}
	if _, err := h.Queries.GetJiraProjectBindingForMember(r.Context(), db.GetJiraProjectBindingForMemberParams{ID: bindingID, WorkspaceID: member.WorkspaceID, MemberID: member.UserID}); err != nil {
		writeError(w, http.StatusNotFound, "jira project binding not found")
		return
	}
	result, err := h.JiraSync.RunBindingSync(r.Context(), bindingID, service.JiraSyncRunManual)
	if err != nil && !result.Run.ID.Valid {
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sync_run": jiraSyncRunToResponse(result.Run)})
}

func (h *Handler) CreateJiraIssueComment(w http.ResponseWriter, r *http.Request) {
	if !h.jiraEnabled(w) {
		return
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	actorID, ok := parseUUIDOrBadRequest(w, userID, "user id")
	if !ok {
		return
	}
	var req struct {
		Body string `json:"body"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	result, err := h.JiraActions.AddComment(r.Context(), issue, actorID, req.Body)
	if err != nil {
		if errors.Is(err, service.ErrJiraIssueNotSynced) {
			writeError(w, http.StatusBadRequest, "issue is not synced from jira")
			return
		}
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"comment": map[string]any{
			"jira_comment_id":     result.JiraComment.ID,
			"body":                req.Body,
			"created_at":          result.JiraComment.Created,
			"author_display_name": result.JiraComment.Author.DisplayName,
		},
		"issue": issueToResponse(result.Issue, h.getIssuePrefix(r.Context(), result.Issue.WorkspaceID)),
	})
}

func (h *Handler) ListJiraIssueTransitions(w http.ResponseWriter, r *http.Request) {
	if !h.jiraEnabled(w) {
		return
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	transitions, err := h.JiraActions.ListTransitions(r.Context(), issue)
	if err != nil {
		if errors.Is(err, service.ErrJiraIssueNotSynced) {
			writeError(w, http.StatusBadRequest, "issue is not synced from jira")
			return
		}
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	out := make([]JiraTransitionResponse, 0, len(transitions))
	for _, transition := range transitions {
		out = append(out, JiraTransitionResponse{ID: transition.ID, Name: transition.Name, ToStatusName: transition.To.Name, ToStatusCategory: transition.To.StatusCategory.Key})
	}
	writeJSON(w, http.StatusOK, map[string]any{"transitions": out})
}

func (h *Handler) TransitionJiraIssue(w http.ResponseWriter, r *http.Request) {
	if !h.jiraEnabled(w) {
		return
	}
	issue, ok := h.loadIssueForUser(w, r, chi.URLParam(r, "id"))
	if !ok {
		return
	}
	var req struct {
		TransitionID string `json:"transition_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	updated, err := h.JiraActions.DoTransition(r.Context(), issue, req.TransitionID)
	if err != nil {
		if errors.Is(err, service.ErrJiraIssueNotSynced) {
			writeError(w, http.StatusBadRequest, "issue is not synced from jira")
			return
		}
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"issue": issueToResponse(updated, h.getIssuePrefix(r.Context(), updated.WorkspaceID))})
}
