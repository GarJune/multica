package handler

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/multica-ai/multica/server/internal/util"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// TestTerminalSessionToResponse_Active validates the shape returned for a
// session whose ended_at is still NULL — the CLI's `issue runs` merge
// expects status="active" and a nil ended_at pointer (not the zero
// timestamp string, which would render as a real completion in the
// table).
func TestTerminalSessionToResponse_Active(t *testing.T) {
	started := time.Date(2026, 5, 16, 10, 30, 0, 0, time.UTC)
	s := db.TerminalSession{
		ID:          util.MustParseUUID("11111111-1111-1111-1111-111111111111"),
		WorkspaceID: util.MustParseUUID("22222222-2222-2222-2222-222222222222"),
		IssueID:     util.MustParseUUID("33333333-3333-3333-3333-333333333333"),
		TaskID:      util.MustParseUUID("44444444-4444-4444-4444-444444444444"),
		UserID:      util.MustParseUUID("55555555-5555-5555-5555-555555555555"),
		WorkDir:     "/tmp/ws/task/workdir",
		Shell:       "/bin/bash",
		StartedAt:   pgtype.Timestamptz{Time: started, Valid: true},
	}

	resp := terminalSessionToResponse(s)

	if resp.Status != "active" {
		t.Errorf("Status = %q, want active", resp.Status)
	}
	if resp.Kind != "terminal" {
		t.Errorf("Kind = %q, want terminal", resp.Kind)
	}
	if resp.EndedAt != nil {
		t.Errorf("EndedAt = %v, want nil", *resp.EndedAt)
	}
	if resp.ExitCode != nil {
		t.Errorf("ExitCode = %v, want nil", *resp.ExitCode)
	}
	if resp.StartedAt != started.Format(time.RFC3339) {
		t.Errorf("StartedAt = %q, want %q", resp.StartedAt, started.Format(time.RFC3339))
	}
}

// TestTerminalSessionToResponse_Closed validates the closed-session shape:
// status flips to "closed", ended_at is a populated pointer, exit_code
// surfaces the signed int. close_reason rides through verbatim so the CLI
// can display it in the ERROR column for terminal rows.
func TestTerminalSessionToResponse_Closed(t *testing.T) {
	started := time.Date(2026, 5, 16, 10, 30, 0, 0, time.UTC)
	ended := started.Add(15 * time.Minute)
	s := db.TerminalSession{
		ID:          util.MustParseUUID("11111111-1111-1111-1111-111111111111"),
		WorkspaceID: util.MustParseUUID("22222222-2222-2222-2222-222222222222"),
		IssueID:     util.MustParseUUID("33333333-3333-3333-3333-333333333333"),
		TaskID:      util.MustParseUUID("44444444-4444-4444-4444-444444444444"),
		UserID:      util.MustParseUUID("55555555-5555-5555-5555-555555555555"),
		WorkDir:     "/tmp/ws/task/workdir",
		StartedAt:   pgtype.Timestamptz{Time: started, Valid: true},
		EndedAt:     pgtype.Timestamptz{Time: ended, Valid: true},
		ExitCode:    pgtype.Int4{Int32: 130, Valid: true},
		CloseReason: "idle_timeout",
	}

	resp := terminalSessionToResponse(s)

	if resp.Status != "closed" {
		t.Errorf("Status = %q, want closed", resp.Status)
	}
	if resp.EndedAt == nil || *resp.EndedAt != ended.Format(time.RFC3339) {
		t.Errorf("EndedAt = %v, want %q", resp.EndedAt, ended.Format(time.RFC3339))
	}
	if resp.ExitCode == nil || *resp.ExitCode != 130 {
		t.Errorf("ExitCode = %v, want 130", resp.ExitCode)
	}
	if resp.CloseReason != "idle_timeout" {
		t.Errorf("CloseReason = %q, want idle_timeout", resp.CloseReason)
	}
}
