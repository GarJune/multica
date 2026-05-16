package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/middleware"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// installTokenTTL bounds how long an install_token stays valid between mint
// and exchange. The RFC (MUL-2297 Phase 1) suggests 15 minutes — long enough
// for a user to copy the snippet, switch to their machine, paste it into an
// installer, and complete a network round-trip; short enough that a token
// leaked onto a chat log or screenshot doesn't stay armed for long.
const installTokenTTL = 15 * time.Minute

// daemonTokenLongLivedExpiry is how far in the future an mdt_ token issued
// via the install_token exchange is dated. The point is "no automatic
// expiry" — explicit revoke via daemon_token.revoked_at is the only way to
// retire one. We keep expires_at NOT NULL (legacy schema constraint) and
// the DeleteExpiredDaemonTokens cleanup query intact by picking a stamp so
// far out that no rational deployment will reach it. See RFC MUL-2297.
const daemonTokenLongLivedExpiry = 100 * 365 * 24 * time.Hour

// CreateInstallTokenResponse is the workspace-admin-facing mint response.
// Token is shown once — the server only retains the hash.
type CreateInstallTokenResponse struct {
	ID          string `json:"id"`
	Token       string `json:"token"`
	WorkspaceID string `json:"workspace_id"`
	ExpiresAt   string `json:"expires_at"`
	CreatedAt   string `json:"created_at"`
}

// CreateInstallToken mints a short-lived single-use install token for the
// authenticated admin's workspace. Routed under
// /api/workspaces/{id}/install-tokens so workspace membership/role is
// enforced by the RequireWorkspaceRoleFromURL middleware before this
// handler runs.
func (h *Handler) CreateInstallToken(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}

	workspaceID := middleware.WorkspaceIDFromContext(r.Context())
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspace_id is required")
		return
	}
	wsUUID, ok := parseUUIDOrBadRequest(w, workspaceID, "workspace_id")
	if !ok {
		return
	}

	rawToken, err := auth.GenerateInstallToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to generate token")
		return
	}

	expiresAt := pgtype.Timestamptz{Time: time.Now().Add(installTokenTTL), Valid: true}

	row, err := h.Queries.CreateInstallToken(r.Context(), db.CreateInstallTokenParams{
		TokenHash:   auth.HashToken(rawToken),
		WorkspaceID: wsUUID,
		CreatedBy:   parseUUID(userID),
		ExpiresAt:   expiresAt,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to create install token")
		return
	}

	writeJSON(w, http.StatusCreated, CreateInstallTokenResponse{
		ID:          uuidToString(row.ID),
		Token:       rawToken,
		WorkspaceID: uuidToString(row.WorkspaceID),
		ExpiresAt:   timestampToString(row.ExpiresAt),
		CreatedAt:   timestampToString(row.CreatedAt),
	})
}

// ExchangeInstallTokenRequest is the public unauthenticated body posted by a
// daemon installer. The mit_ token itself is the credential.
type ExchangeInstallTokenRequest struct {
	Token    string `json:"token"`
	DaemonID string `json:"daemon_id"`
}

// ExchangeInstallTokenResponse returns the long-lived daemon token. The
// caller stores `token` and authenticates subsequent /api/daemon/* requests
// with it.
type ExchangeInstallTokenResponse struct {
	Token       string `json:"token"`
	WorkspaceID string `json:"workspace_id"`
	DaemonID    string `json:"daemon_id"`
	ExpiresAt   string `json:"expires_at"`
}

// ExchangeInstallToken validates a `mit_` install token, atomically burns
// it, and returns a fresh long-lived `mdt_` daemon token bound to the
// caller-supplied daemon_id. Public (no Authorization header) — the install
// token IS the credential.
//
// Error contract (Phase 2 daemon depends on these):
//   - 400  `invalid_install_token` — malformed body or missing fields
//   - 401  `invalid_install_token` — unknown hash OR expired
//   - 401  `install_token_already_used` — hash exists but used_at IS NOT NULL
//   - 500  any DB / token-gen failure
func (h *Handler) ExchangeInstallToken(w http.ResponseWriter, r *http.Request) {
	var req ExchangeInstallTokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_install_token")
		return
	}
	req.Token = strings.TrimSpace(req.Token)
	req.DaemonID = strings.TrimSpace(req.DaemonID)
	if req.Token == "" || !strings.HasPrefix(req.Token, "mit_") {
		writeError(w, http.StatusBadRequest, "invalid_install_token")
		return
	}
	if req.DaemonID == "" {
		writeError(w, http.StatusBadRequest, "daemon_id is required")
		return
	}

	hash := auth.HashToken(req.Token)

	// Try to consume the row atomically (single UPDATE flips used_at). A
	// miss here means one of: unknown hash, expired, or already used. We
	// disambiguate with a follow-up read so the "already used" path can
	// return the dedicated error code the daemon installer surfaces to
	// the user — that copy explicitly tells them to mint a fresh mit_.
	consumed, err := h.Queries.ConsumeInstallToken(r.Context(), hash)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusInternalServerError, "failed to exchange install token")
			return
		}
		existing, lookupErr := h.Queries.GetInstallTokenByHash(r.Context(), hash)
		if lookupErr == nil && existing.UsedAt.Valid {
			writeError(w, http.StatusUnauthorized, "install_token_already_used")
			return
		}
		writeError(w, http.StatusUnauthorized, "invalid_install_token")
		return
	}

	daemonToken, err := auth.GenerateDaemonToken()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to generate daemon token")
		return
	}
	expiresAt := pgtype.Timestamptz{
		Time:  time.Now().Add(daemonTokenLongLivedExpiry),
		Valid: true,
	}

	created, err := h.Queries.CreateDaemonToken(r.Context(), db.CreateDaemonTokenParams{
		TokenHash:   auth.HashToken(daemonToken),
		WorkspaceID: consumed.WorkspaceID,
		DaemonID:    req.DaemonID,
		ExpiresAt:   expiresAt,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to issue daemon token")
		return
	}

	writeJSON(w, http.StatusOK, ExchangeInstallTokenResponse{
		Token:       daemonToken,
		WorkspaceID: uuidToString(created.WorkspaceID),
		DaemonID:    created.DaemonID,
		ExpiresAt:   timestampToString(created.ExpiresAt),
	})
}
