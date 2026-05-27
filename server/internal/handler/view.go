package handler

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/pkg/protocol"
)

type SavedViewResponse struct {
	ID          string          `json:"id"`
	WorkspaceID string          `json:"workspace_id"`
	CreatorID   *string         `json:"creator_id"`
	Name        string          `json:"name"`
	Page        string          `json:"page"`
	ProjectID   *string         `json:"project_id"`
	Filters     json.RawMessage `json:"filters"`
	Position    float64         `json:"position"`
	Shared      bool            `json:"shared"`
	IsDefault   bool            `json:"is_default"`
	CreatedAt   string          `json:"created_at"`
	UpdatedAt   string          `json:"updated_at"`
}

func savedViewToResponse(v db.SavedView) SavedViewResponse {
	filters := json.RawMessage(v.Filters)
	if len(filters) == 0 {
		filters = json.RawMessage("{}")
	}
	return SavedViewResponse{
		ID:          uuidToString(v.ID),
		WorkspaceID: uuidToString(v.WorkspaceID),
		CreatorID:   uuidToPtr(v.CreatorID),
		Name:        v.Name,
		Page:        v.Page,
		ProjectID:   uuidToPtr(v.ProjectID),
		Filters:     filters,
		Position:    v.Position,
		Shared:      v.Shared,
		IsDefault:   v.IsDefault,
		CreatedAt:   timestampToString(v.CreatedAt),
		UpdatedAt:   timestampToString(v.UpdatedAt),
	}
}

type CreateViewRequest struct {
	Name      string          `json:"name"`
	Page      string          `json:"page"`
	ProjectID *string         `json:"project_id"`
	Filters   json.RawMessage `json:"filters"`
	Shared    bool            `json:"shared"`
}

type UpdateViewRequest struct {
	Name    *string          `json:"name"`
	Filters *json.RawMessage `json:"filters"`
	Shared  *bool            `json:"shared"`
}

type ReorderViewsRequest struct {
	Items []ReorderViewItem `json:"items"`
}

type ReorderViewItem struct {
	ID       string  `json:"id"`
	Position float64 `json:"position"`
}

var validPages = map[string]bool{
	"issues":    true,
	"my_issues": true,
	"project":   true,
}

// defaultViewDef describes a single default view for lazy creation.
type defaultViewDef struct {
	Name      string
	Filters   string
	Position  float64
	IsDefault bool
}

var defaultViewsByPage = map[string][]defaultViewDef{
	"issues": {
		{Name: "All", Filters: `{}`, Position: 1, IsDefault: true},
		{Name: "Members", Filters: `{"assignee_type":["member"]}`, Position: 2, IsDefault: false},
		{Name: "Agents", Filters: `{"assignee_type":["agent","squad"]}`, Position: 3, IsDefault: false},
	},
	"my_issues": {
		{Name: "All", Filters: `{"involves":"{me}"}`, Position: 1, IsDefault: true},
		{Name: "Assigned", Filters: `{"assignee":"{me}"}`, Position: 2, IsDefault: false},
		{Name: "Created", Filters: `{"creator":"{me}"}`, Position: 3, IsDefault: false},
		{Name: "My Agents", Filters: `{"involves":"{me}","assignee_type":["agent","squad"]}`, Position: 4, IsDefault: false},
	},
	"project": {
		{Name: "All", Filters: `{}`, Position: 1, IsDefault: true},
	},
}

func (h *Handler) ListViews(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)

	page := r.URL.Query().Get("page")
	if page == "" {
		writeError(w, http.StatusBadRequest, "page query parameter is required")
		return
	}
	if !validPages[page] {
		writeError(w, http.StatusBadRequest, "page must be one of: issues, my_issues, project")
		return
	}
	if page == "project" && r.URL.Query().Get("project_id") == "" {
		writeError(w, http.StatusBadRequest, "project_id is required when page is 'project'")
		return
	}

	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}

	params := db.ListSavedViewsParams{
		WorkspaceID: wsUUID,
		Page:        page,
	}
	if projectID := r.URL.Query().Get("project_id"); projectID != "" {
		pid, ok := parseUUIDOrBadRequest(w, projectID, "project_id")
		if !ok {
			return
		}
		if _, err := h.Queries.GetProjectInWorkspace(r.Context(), db.GetProjectInWorkspaceParams{
			ID: pid, WorkspaceID: wsUUID,
		}); err != nil {
			writeError(w, http.StatusNotFound, "project not found")
			return
		}
		params.ProjectID = pid
	}

	// Lazy-create default views on first access (ON CONFLICT DO NOTHING).
	if defs, ok := defaultViewsByPage[page]; ok {
		for _, d := range defs {
			_ = h.Queries.EnsureDefaultViews(r.Context(), db.EnsureDefaultViewsParams{
				WorkspaceID: wsUUID,
				Name:        d.Name,
				Page:        page,
				ProjectID:   params.ProjectID,
				Filters:     json.RawMessage(d.Filters),
				Position:    d.Position,
				IsDefault:   d.IsDefault,
			})
		}
	}

	views, err := h.Queries.ListSavedViews(r.Context(), params)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list views")
		return
	}

	items := make([]SavedViewResponse, 0, len(views))
	for _, v := range views {
		items = append(items, savedViewToResponse(v))
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"views": items,
		"total": len(items),
	})
}

func (h *Handler) CreateView(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)

	var req CreateViewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if !validPages[req.Page] {
		writeError(w, http.StatusBadRequest, "page must be one of: issues, my_issues, project")
		return
	}
	if req.Page == "project" && req.ProjectID == nil {
		writeError(w, http.StatusBadRequest, "project_id is required when page is 'project'")
		return
	}

	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}

	filters := req.Filters
	if len(filters) == 0 {
		filters = json.RawMessage("{}")
	}
	if !json.Valid(filters) {
		writeError(w, http.StatusBadRequest, "filters must be valid JSON")
		return
	}

	params := db.CreateSavedViewParams{
		WorkspaceID: wsUUID,
		CreatorID:   parseUUID(userID),
		Name:        req.Name,
		Page:        req.Page,
		Filters:     filters,
		Shared:      req.Shared,
		IsDefault:   false,
	}

	if req.ProjectID != nil {
		pid, ok := parseUUIDOrBadRequest(w, *req.ProjectID, "project_id")
		if !ok {
			return
		}
		if _, err := h.Queries.GetProjectInWorkspace(r.Context(), db.GetProjectInWorkspaceParams{
			ID: pid, WorkspaceID: wsUUID,
		}); err != nil {
			writeError(w, http.StatusNotFound, "project not found")
			return
		}
		params.ProjectID = pid
	}

	maxPos, err := h.Queries.GetMaxSavedViewPosition(r.Context(), db.GetMaxSavedViewPositionParams{
		WorkspaceID: wsUUID,
		Page:        req.Page,
		ProjectID:   params.ProjectID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get position")
		return
	}
	params.Position = maxPos + 1

	view, err := h.Queries.CreateSavedView(r.Context(), params)
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "a view with this name already exists on this page")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to create view")
		return
	}

	resp := savedViewToResponse(view)
	h.publish(protocol.EventViewCreated, workspaceID, "member", userID, map[string]any{"view": resp})
	writeJSON(w, http.StatusCreated, resp)
}

func (h *Handler) UpdateView(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	viewID := chi.URLParam(r, "id")

	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	viewUUID, ok := parseUUIDOrBadRequest(w, viewID, "view id")
	if !ok {
		return
	}

	existing, err := h.Queries.GetSavedView(r.Context(), db.GetSavedViewParams{
		ID:          viewUUID,
		WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "view not found")
		return
	}

	if !h.canManageView(w, r, existing) {
		return
	}

	var req UpdateViewRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	params := db.UpdateSavedViewParams{
		ID:          viewUUID,
		WorkspaceID: wsUUID,
	}
	if req.Name != nil {
		params.Name = strToText(*req.Name)
	}
	if req.Filters != nil {
		if !json.Valid(*req.Filters) {
			writeError(w, http.StatusBadRequest, "filters must be valid JSON")
			return
		}
		params.Filters = *req.Filters
	}
	if req.Shared != nil {
		params.Shared = pgtype.Bool{Bool: *req.Shared, Valid: true}
	}

	view, err := h.Queries.UpdateSavedView(r.Context(), params)
	if err != nil {
		if isUniqueViolation(err) {
			writeError(w, http.StatusConflict, "a view with this name already exists on this page")
			return
		}
		writeError(w, http.StatusInternalServerError, "failed to update view")
		return
	}

	resp := savedViewToResponse(view)
	h.publish(protocol.EventViewUpdated, workspaceID, "member", userID, map[string]any{"view": resp})
	writeJSON(w, http.StatusOK, resp)
}

func (h *Handler) DeleteView(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)
	viewID := chi.URLParam(r, "id")

	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}
	viewUUID, ok := parseUUIDOrBadRequest(w, viewID, "view id")
	if !ok {
		return
	}

	existing, err := h.Queries.GetSavedView(r.Context(), db.GetSavedViewParams{
		ID:          viewUUID,
		WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusNotFound, "view not found")
		return
	}

	if existing.IsDefault {
		writeError(w, http.StatusForbidden, "cannot delete a default view")
		return
	}

	if !h.canManageView(w, r, existing) {
		return
	}

	err = h.Queries.DeleteSavedView(r.Context(), db.DeleteSavedViewParams{
		ID:          viewUUID,
		WorkspaceID: wsUUID,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to delete view")
		return
	}

	h.publish(protocol.EventViewDeleted, workspaceID, "member", userID, map[string]any{
		"view_id": viewID,
		"page":    existing.Page,
	})
	w.WriteHeader(http.StatusNoContent)
}

func (h *Handler) ReorderViews(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)

	var req ReorderViewsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace id")
	if !ok {
		return
	}

	for _, item := range req.Items {
		itemUUID, ok := parseUUIDOrBadRequest(w, item.ID, "items[].id")
		if !ok {
			return
		}
		existing, err := h.Queries.GetSavedView(r.Context(), db.GetSavedViewParams{
			ID: itemUUID, WorkspaceID: wsUUID,
		})
		if err != nil {
			writeError(w, http.StatusNotFound, "view not found")
			return
		}
		if !h.canManageView(w, r, existing) {
			return
		}
		if err := h.Queries.UpdateSavedViewPosition(r.Context(), db.UpdateSavedViewPositionParams{
			Position:    item.Position,
			ID:          itemUUID,
			WorkspaceID: wsUUID,
		}); err != nil {
			writeError(w, http.StatusInternalServerError, "failed to reorder views")
			return
		}
	}

	h.publish(protocol.EventViewReordered, workspaceID, "member", userID, map[string]any{"items": req.Items})
	w.WriteHeader(http.StatusNoContent)
}

// canManageView checks whether the current user can update or delete a view.
// The view creator or workspace owner/admin can manage any view.
func (h *Handler) canManageView(w http.ResponseWriter, r *http.Request, view db.SavedView) bool {
	wsID := uuidToString(view.WorkspaceID)
	member, ok := h.requireWorkspaceMember(w, r, wsID, "view not found")
	if !ok {
		return false
	}
	isAdmin := roleAllowed(member.Role, "owner", "admin")
	isCreator := view.CreatorID.Valid && uuidToString(view.CreatorID) == requestUserID(r)
	if !isAdmin && !isCreator {
		writeError(w, http.StatusForbidden, "only the view creator or workspace admin can manage this view")
		return false
	}
	return true
}
