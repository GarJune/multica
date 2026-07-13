package scheduler

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/multica-ai/multica/server/internal/service"

	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

const JobNameJiraPollingSync = "jira_polling_sync"
const ScopeKindJiraProjectBinding = "jira_project_binding"

type JiraBindingSyncer interface {
	RunBindingSync(ctx context.Context, bindingID pgtype.UUID, runType string) (service.JiraSyncResult, error)
}

func JiraPollingSyncJob(queries *db.Queries, syncer JiraBindingSyncer) JobSpec {
	return JobSpec{
		Name:              JobNameJiraPollingSync,
		Cadence:           5 * time.Minute,
		ScheduleDelay:     0,
		CatchUpMode:       CatchUpLatestOnly,
		CatchUpWindow:     time.Hour,
		RunTimeout:        2 * time.Minute,
		StaleTimeout:      5 * time.Minute,
		HeartbeatInterval: 30 * time.Second,
		AllowStaleReentry: true,
		MaxAttempts:       3,
		RetryBackoff: []time.Duration{
			1 * time.Minute,
			5 * time.Minute,
			15 * time.Minute,
		},
		Scopes:  jiraBindingScopes(queries),
		Handler: jiraPollingHandler(syncer),
	}
}

func jiraBindingScopes(queries *db.Queries) ScopeProvider {
	return func(ctx context.Context, now time.Time) ([]Scope, error) {
		bindings, err := queries.ListDueJiraProjectBindings(ctx, pgtype.Timestamptz{Time: now, Valid: true})
		if err != nil {
			return nil, fmt.Errorf("jira scope: list due bindings: %w", err)
		}
		scopes := make([]Scope, 0, len(bindings))
		for _, binding := range bindings {
			id := uuidToScopeID(binding.ID)
			if id == "" {
				continue
			}
			scopes = append(scopes, Scope{Kind: ScopeKindJiraProjectBinding, ID: id})
		}
		return scopes, nil
	}
}

func jiraPollingHandler(syncer JiraBindingSyncer) Handler {
	return func(ctx context.Context, in HandlerInput) (HandlerResult, error) {
		bindingID, err := parseScopeUUID(in.Scope.ID)
		if err != nil {
			return HandlerResult{}, fmt.Errorf("jira handler: scope id is not a valid uuid: %w", err)
		}
		if syncer == nil {
			return HandlerResult{}, fmt.Errorf("jira handler: syncer is not configured")
		}
		result, err := syncer.RunBindingSync(ctx, bindingID, "scheduled")
		if err != nil {
			return HandlerResult{}, err
		}
		return HandlerResult{RowsAffected: 1, Result: map[string]any{"result": result}}, nil
	}
}

func uuidToScopeID(id pgtype.UUID) string {
	if !id.Valid {
		return ""
	}
	return fmt.Sprintf("%x-%x-%x-%x-%x", id.Bytes[0:4], id.Bytes[4:6], id.Bytes[6:8], id.Bytes[8:10], id.Bytes[10:16])
}
