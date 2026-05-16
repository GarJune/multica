package handler

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/multica-ai/multica/server/internal/auth"
	"github.com/multica-ai/multica/server/internal/middleware"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
	"github.com/multica-ai/multica/server/internal/util"
)

// withWorkspaceContext primes the workspace ID into the request context the
// same way the RequireWorkspaceMember* middleware does in production. The
// handler tests bypass the real middleware chain.
func withWorkspaceContext(t *testing.T, req *http.Request, workspaceID string) *http.Request {
	t.Helper()
	memberRow, err := testHandler.Queries.GetMemberByUserAndWorkspace(context.Background(), db.GetMemberByUserAndWorkspaceParams{
		UserID:      util.MustParseUUID(testUserID),
		WorkspaceID: util.MustParseUUID(workspaceID),
	})
	if err != nil {
		t.Fatalf("load member row: %v", err)
	}
	return req.WithContext(middleware.SetMemberContext(req.Context(), workspaceID, memberRow))
}

func TestCreateInstallToken_ReturnsMitTokenAndPersistsHash(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/workspaces/"+testWorkspaceID+"/install-tokens", nil)
	req = withWorkspaceContext(t, req, testWorkspaceID)
	testHandler.CreateInstallToken(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("CreateInstallToken: expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var resp CreateInstallTokenResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !strings.HasPrefix(resp.Token, "mit_") {
		t.Fatalf("expected mit_ prefix, got %q", resp.Token)
	}
	if resp.ID == "" || resp.WorkspaceID != testWorkspaceID {
		t.Fatalf("expected workspace_id %q with non-empty id, got %+v", testWorkspaceID, resp)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM install_token WHERE id = $1`, resp.ID)
	})

	// Server must store hash, not raw token. The raw token must not appear
	// in any column.
	sum := sha256.Sum256([]byte(resp.Token))
	wantHash := hex.EncodeToString(sum[:])
	var gotHash string
	var usedAt *time.Time
	var expiresAt time.Time
	if err := testPool.QueryRow(context.Background(),
		`SELECT token_hash, used_at, expires_at FROM install_token WHERE id = $1`, resp.ID,
	).Scan(&gotHash, &usedAt, &expiresAt); err != nil {
		t.Fatalf("read install_token row: %v", err)
	}
	if gotHash != wantHash {
		t.Fatalf("expected token_hash %q, got %q", wantHash, gotHash)
	}
	if usedAt != nil {
		t.Fatalf("expected used_at NULL on fresh token, got %v", usedAt)
	}
	// Expiry must land in (now, now + 30m]: TTL is 15m, but we allow slop
	// for slow CI runs and clock drift between Go and Postgres.
	if expiresAt.Before(time.Now()) || expiresAt.After(time.Now().Add(30*time.Minute)) {
		t.Fatalf("expires_at %v not within (now, now+30m]", expiresAt)
	}
}

func TestExchangeInstallToken_HappyPath(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	rawInstall, installID := seedInstallToken(t, testWorkspaceID, 5*time.Minute)
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM install_token WHERE id = $1`, installID)
	})

	const daemonID = "test-daemon-exchange-happy"
	body := map[string]any{"token": rawInstall, "daemon_id": daemonID}
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/install-tokens/exchange", body)
	testHandler.ExchangeInstallToken(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("ExchangeInstallToken: expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp ExchangeInstallTokenResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if !strings.HasPrefix(resp.Token, "mdt_") {
		t.Fatalf("expected mdt_ prefix on returned daemon token, got %q", resp.Token)
	}
	if resp.WorkspaceID != testWorkspaceID || resp.DaemonID != daemonID {
		t.Fatalf("unexpected response: %+v", resp)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM daemon_token WHERE token_hash = $1`, auth.HashToken(resp.Token))
	})

	// install_token row must be burned (used_at populated).
	var usedAt *time.Time
	if err := testPool.QueryRow(context.Background(),
		`SELECT used_at FROM install_token WHERE id = $1`, installID,
	).Scan(&usedAt); err != nil {
		t.Fatalf("read install_token after exchange: %v", err)
	}
	if usedAt == nil {
		t.Fatal("expected install_token.used_at to be set after exchange")
	}

	// daemon_token row must exist, unrevoked, with the ~100y long-lived
	// expiry (well past anything a TTL-style mint would produce).
	var dtExpiresAt time.Time
	var revokedAt *time.Time
	if err := testPool.QueryRow(context.Background(),
		`SELECT expires_at, revoked_at FROM daemon_token WHERE token_hash = $1`,
		auth.HashToken(resp.Token),
	).Scan(&dtExpiresAt, &revokedAt); err != nil {
		t.Fatalf("read daemon_token: %v", err)
	}
	if revokedAt != nil {
		t.Fatalf("expected daemon_token.revoked_at NULL, got %v", revokedAt)
	}
	if dtExpiresAt.Before(time.Now().Add(50 * 365 * 24 * time.Hour)) {
		t.Fatalf("expected long-lived expiry (>50y), got %v", dtExpiresAt)
	}
}

func TestExchangeInstallToken_DoubleExchangeRejected(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	rawInstall, installID := seedInstallToken(t, testWorkspaceID, 5*time.Minute)
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM install_token WHERE id = $1`, installID)
	})

	const daemonID = "test-daemon-double-exchange"
	body := map[string]any{"token": rawInstall, "daemon_id": daemonID}

	// First exchange must succeed.
	w := httptest.NewRecorder()
	testHandler.ExchangeInstallToken(w, newRequest("POST", "/api/install-tokens/exchange", body))
	if w.Code != http.StatusOK {
		t.Fatalf("first exchange: expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var first ExchangeInstallTokenResponse
	if err := json.Unmarshal(w.Body.Bytes(), &first); err != nil {
		t.Fatalf("decode first response: %v", err)
	}
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM daemon_token WHERE token_hash = $1`, auth.HashToken(first.Token))
	})

	// Second exchange must fail with the dedicated error code so the daemon
	// installer can surface the "请重新生成 mit_" guidance from the RFC.
	w = httptest.NewRecorder()
	testHandler.ExchangeInstallToken(w, newRequest("POST", "/api/install-tokens/exchange", body))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("second exchange: expected 401, got %d: %s", w.Code, w.Body.String())
	}
	var errBody map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody["error"] != "install_token_already_used" {
		t.Fatalf("expected install_token_already_used, got %q", errBody["error"])
	}
}

func TestExchangeInstallToken_UnknownTokenRejected(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	w := httptest.NewRecorder()
	body := map[string]any{
		"token":     "mit_unknown_never_minted_token_hex_padding_4",
		"daemon_id": "test-daemon-unknown-mit",
	}
	testHandler.ExchangeInstallToken(w, newRequest("POST", "/api/install-tokens/exchange", body))

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
	}
	var errBody map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if errBody["error"] != "invalid_install_token" {
		t.Fatalf("expected invalid_install_token, got %q", errBody["error"])
	}
}

func TestExchangeInstallToken_ExpiredTokenRejected(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	rawInstall, installID := seedInstallToken(t, testWorkspaceID, -1*time.Minute)
	t.Cleanup(func() {
		testPool.Exec(context.Background(), `DELETE FROM install_token WHERE id = $1`, installID)
	})

	body := map[string]any{"token": rawInstall, "daemon_id": "test-daemon-expired-mit"}
	w := httptest.NewRecorder()
	testHandler.ExchangeInstallToken(w, newRequest("POST", "/api/install-tokens/exchange", body))

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", w.Code, w.Body.String())
	}
	var errBody map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &errBody); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	// An expired-but-never-used token reports invalid_install_token, not
	// install_token_already_used — the daemon installer's recovery copy
	// is "mint a fresh token", which is correct for both cases.
	if errBody["error"] != "invalid_install_token" {
		t.Fatalf("expected invalid_install_token for expired row, got %q", errBody["error"])
	}
}

// TestGetDaemonTokenByHash_FiltersRevoked guards the D4 schema change: once a
// daemon_token row has revoked_at set, GetDaemonTokenByHash (which feeds the
// DaemonAuth middleware) must refuse to resolve it even though expires_at is
// still in the future. The bug we're preventing is a revoked daemon
// continuing to authenticate until the original short-TTL expiry.
func TestGetDaemonTokenByHash_FiltersRevoked(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}

	const daemonID = "test-daemon-revoked-filter"
	rawToken, hash := seedDaemonToken(t, testWorkspaceID, daemonID, 100*365*24*time.Hour)

	// Before revoke, the row resolves.
	if _, err := testHandler.Queries.GetDaemonTokenByHash(context.Background(), hash); err != nil {
		t.Fatalf("pre-revoke lookup: %v", err)
	}

	if _, err := testPool.Exec(context.Background(),
		`UPDATE daemon_token SET revoked_at = now() WHERE token_hash = $1`, hash,
	); err != nil {
		t.Fatalf("revoke row: %v", err)
	}

	// After revoke, the row must vanish from the auth path even though
	// expires_at is decades out.
	_, err := testHandler.Queries.GetDaemonTokenByHash(context.Background(), hash)
	if err == nil {
		t.Fatal("expected GetDaemonTokenByHash to fail for revoked row")
	}

	// Tidy up: rawToken isn't an authentication concern (it was never
	// returned to a client), but leaving the row around taints later runs
	// of the same fixture.
	_ = rawToken
	testPool.Exec(context.Background(), `DELETE FROM daemon_token WHERE token_hash = $1`, hash)
}

// seedInstallToken inserts an install_token row directly so tests don't have
// to run the mint endpoint just to get a known-good raw token. ttl<=0 mints
// an already-expired row (ExpiresAt set in the past).
func seedInstallToken(t *testing.T, workspaceID string, ttl time.Duration) (string, string) {
	t.Helper()
	raw, err := auth.GenerateInstallToken()
	if err != nil {
		t.Fatalf("generate install token: %v", err)
	}
	hash := auth.HashToken(raw)
	var id string
	if err := testPool.QueryRow(context.Background(), `
INSERT INTO install_token (token_hash, workspace_id, created_by, expires_at)
VALUES ($1, $2, $3, now() + $4::interval)
RETURNING id
`, hash, workspaceID, testUserID, formatInterval(ttl)).Scan(&id); err != nil {
		t.Fatalf("seed install_token: %v", err)
	}
	return raw, id
}

func seedDaemonToken(t *testing.T, workspaceID, daemonID string, ttl time.Duration) (string, string) {
	t.Helper()
	raw, err := auth.GenerateDaemonToken()
	if err != nil {
		t.Fatalf("generate daemon token: %v", err)
	}
	hash := auth.HashToken(raw)
	if _, err := testPool.Exec(context.Background(), `
INSERT INTO daemon_token (token_hash, workspace_id, daemon_id, expires_at)
VALUES ($1, $2, $3, now() + $4::interval)
`, hash, workspaceID, daemonID, formatInterval(ttl)); err != nil {
		t.Fatalf("seed daemon_token: %v", err)
	}
	return raw, hash
}

// formatInterval renders a Go duration as a Postgres interval literal.
// Sub-second precision isn't needed for these tests; we clamp to whole
// seconds (with sign) so negative TTLs still produce a valid interval like
// "-60 seconds" for the expired-token case.
func formatInterval(d time.Duration) string {
	secs := int64(d / time.Second)
	if secs == 0 && d != 0 {
		if d > 0 {
			secs = 1
		} else {
			secs = -1
		}
	}
	return fmt.Sprintf("%d seconds", secs)
}
