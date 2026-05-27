package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

// captureLogger returns a *slog.Logger whose output lands in buf, so tests
// can assert on the daemon's user-facing warning text without scraping
// stderr.
func captureLogger(buf *bytes.Buffer) *slog.Logger {
	return slog.New(slog.NewTextHandler(buf, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

func TestClient_RenewToken_PostsToCorrectEndpoint(t *testing.T) {
	var called atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Add(1)
		if r.Method != http.MethodPost {
			t.Errorf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/api/tokens/current/renew" {
			t.Errorf("expected /api/tokens/current/renew, got %s", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer mul_abc" {
			t.Errorf("expected Bearer mul_abc, got %q", got)
		}
		// Body must be valid JSON — postJSON marshals an empty object when
		// reqBody is a non-nil map[string]any{}.
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"expires_at": "2099-01-02T03:04:05Z",
			"renewed":    true,
		})
	}))
	t.Cleanup(srv.Close)

	c := NewClient(srv.URL)
	c.SetToken("mul_abc")

	resp, err := c.RenewToken(context.Background())
	if err != nil {
		t.Fatalf("RenewToken: %v", err)
	}
	if called.Load() != 1 {
		t.Fatalf("expected 1 server call, got %d", called.Load())
	}
	if !resp.Renewed {
		t.Fatal("expected renewed=true")
	}
	if resp.ExpiresAt != "2099-01-02T03:04:05Z" {
		t.Fatalf("expected expires_at to round-trip, got %q", resp.ExpiresAt)
	}
}

func TestTryRenewToken_LogsRenewalOnSuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"expires_at": "2099-01-02T03:04:05Z",
			"renewed":    true,
		})
	}))
	t.Cleanup(srv.Close)

	var buf bytes.Buffer
	d := &Daemon{client: NewClient(srv.URL), logger: captureLogger(&buf)}
	d.tryRenewToken(context.Background())

	out := buf.String()
	if !strings.Contains(out, "auth token renewed") {
		t.Fatalf("expected 'auth token renewed' log, got: %s", out)
	}
	if !strings.Contains(out, "2099-01-02T03:04:05Z") {
		t.Fatalf("expected new expiry in log, got: %s", out)
	}
}

func TestTryRenewToken_LogsNotEligibleOnNoOp(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"expires_at": "2099-01-02T03:04:05Z",
			"renewed":    false,
		})
	}))
	t.Cleanup(srv.Close)

	var buf bytes.Buffer
	d := &Daemon{client: NewClient(srv.URL), logger: captureLogger(&buf)}
	d.tryRenewToken(context.Background())

	out := buf.String()
	// Non-renewal must NOT emit the warning that an operator would interpret
	// as "something is wrong" — it's the normal steady-state for tokens with
	// plenty of life left.
	if strings.Contains(out, "WARN") {
		t.Fatalf("no-op renewal should not log at WARN, got: %s", out)
	}
}

func TestTryRenewToken_SurfacesReloginWarningOn401(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"invalid token"}`))
	}))
	t.Cleanup(srv.Close)

	var buf bytes.Buffer
	d := &Daemon{client: NewClient(srv.URL), logger: captureLogger(&buf)}
	d.tryRenewToken(context.Background())

	out := buf.String()
	if !strings.Contains(out, "level=WARN") {
		t.Fatalf("401 must surface as WARN, got: %s", out)
	}
	if !strings.Contains(out, "multica login") {
		t.Fatalf("401 warning must tell the user to run 'multica login', got: %s", out)
	}
}

func TestTryRenewToken_SurfacesReloginWarningOn401_WithProfile(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":"invalid token"}`))
	}))
	t.Cleanup(srv.Close)

	var buf bytes.Buffer
	d := &Daemon{
		client: NewClient(srv.URL),
		logger: captureLogger(&buf),
		cfg:    Config{Profile: "staging"},
	}
	d.tryRenewToken(context.Background())

	out := buf.String()
	if !strings.Contains(out, "--profile staging") {
		t.Fatalf("profile-aware login hint missing, got: %s", out)
	}
}

func TestTryRenewToken_TransientErrorIsDebugNotWarn(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"db down"}`))
	}))
	t.Cleanup(srv.Close)

	var buf bytes.Buffer
	d := &Daemon{client: NewClient(srv.URL), logger: captureLogger(&buf)}
	d.tryRenewToken(context.Background())

	out := buf.String()
	// A 500 is transient — the next tick will retry, so the operator should
	// NOT see a re-login warning that doesn't reflect the actual cause.
	if strings.Contains(out, "level=WARN") {
		t.Fatalf("transient 500 should not log at WARN, got: %s", out)
	}
	if !strings.Contains(out, "token renewal failed") {
		t.Fatalf("expected debug log about renewal failure, got: %s", out)
	}
}

func TestTryRenewToken_RespectsContextTimeout(t *testing.T) {
	// Server that never responds — the per-call 15s timeout inside
	// tryRenewToken is too long for a unit test, so cancel the parent
	// context immediately and verify the call returns.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
		_, _ = io.Copy(io.Discard, r.Body)
	}))
	t.Cleanup(srv.Close)

	var buf bytes.Buffer
	d := &Daemon{client: NewClient(srv.URL), logger: captureLogger(&buf)}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan struct{})
	go func() {
		d.tryRenewToken(ctx)
		close(done)
	}()
	select {
	case <-done:
		// Expected: tryRenewToken returns once the cancelled ctx propagates
		// through the HTTP client.
	case <-context.Background().Done():
	}
}
