package daemon

import (
	"context"
	"errors"
	"log/slog"
	"sync/atomic"
	"testing"

	"github.com/multica-ai/multica/server/internal/cli"
)

// newAutoUpdateTestDaemon returns a Daemon stripped to just the pieces
// tryAutoUpdate touches, plus a sentinel cancelFunc the test can assert on to
// detect that triggerRestart fired. The caller is expected to install its own
// runUpdateFn before calling tryAutoUpdate when it wants to exercise the
// upgrade-success path.
func newAutoUpdateTestDaemon(t *testing.T, currentVersion string) (*Daemon, *atomic.Int32) {
	t.Helper()
	var restartCalls atomic.Int32
	d := &Daemon{
		cfg:    Config{CLIVersion: currentVersion, AutoUpdateEnabled: true},
		logger: slog.Default(),
		cancelFunc: func() {
			restartCalls.Add(1)
		},
	}
	d.runUpdateFn = func(string) (string, error) {
		t.Fatalf("runUpdateFn called unexpectedly")
		return "", nil
	}
	return d, &restartCalls
}

func withStubRelease(t *testing.T, release *cli.GitHubRelease, err error) {
	t.Helper()
	prev := fetchLatestRelease
	fetchLatestRelease = func() (*cli.GitHubRelease, error) { return release, err }
	t.Cleanup(func() { fetchLatestRelease = prev })
}

func TestTryAutoUpdate_SkipsWhenUpdating(t *testing.T) {
	d, restartCalls := newAutoUpdateTestDaemon(t, "v0.1.13")
	d.updating.Store(true)
	withStubRelease(t, &cli.GitHubRelease{TagName: "v0.1.14"}, nil)

	d.tryAutoUpdate(context.Background())

	if restartCalls.Load() != 0 {
		t.Fatalf("triggerRestart called while another update was in progress")
	}
}

func TestTryAutoUpdate_SkipsWhenTasksRunning(t *testing.T) {
	d, restartCalls := newAutoUpdateTestDaemon(t, "v0.1.13")
	d.activeTasks.Store(1)
	withStubRelease(t, &cli.GitHubRelease{TagName: "v0.1.14"}, nil)

	d.tryAutoUpdate(context.Background())

	if restartCalls.Load() != 0 {
		t.Fatalf("triggerRestart fired with active tasks; auto-update must defer")
	}
	if d.updating.Load() {
		t.Fatalf("updating flag should not have been claimed while tasks were running")
	}
}

func TestTryAutoUpdate_SkipsWhenFetchFails(t *testing.T) {
	d, restartCalls := newAutoUpdateTestDaemon(t, "v0.1.13")
	withStubRelease(t, nil, errors.New("network down"))

	d.tryAutoUpdate(context.Background())

	if restartCalls.Load() != 0 {
		t.Fatalf("triggerRestart fired despite fetch failure")
	}
}

func TestTryAutoUpdate_SkipsWhenNotNewer(t *testing.T) {
	d, restartCalls := newAutoUpdateTestDaemon(t, "v0.1.13")
	withStubRelease(t, &cli.GitHubRelease{TagName: "v0.1.13"}, nil)

	d.tryAutoUpdate(context.Background())

	if restartCalls.Load() != 0 {
		t.Fatalf("triggerRestart fired even though latest == current")
	}
}

func TestTryAutoUpdate_RunsUpgradeAndRestartsOnNewer(t *testing.T) {
	d, restartCalls := newAutoUpdateTestDaemon(t, "v0.1.13")
	withStubRelease(t, &cli.GitHubRelease{TagName: "v0.1.14"}, nil)

	var upgradedTo string
	d.runUpdateFn = func(target string) (string, error) {
		upgradedTo = target
		return "upgraded", nil
	}

	d.tryAutoUpdate(context.Background())

	if upgradedTo != "v0.1.14" {
		t.Fatalf("runUpdateFn called with %q, want v0.1.14", upgradedTo)
	}
	if restartCalls.Load() != 1 {
		t.Fatalf("triggerRestart fired %d times, want 1", restartCalls.Load())
	}
	if !d.updating.Load() {
		t.Fatalf("updating flag should remain set across the restart kick; got cleared")
	}
}

func TestTryAutoUpdate_DoesNotRestartOnUpgradeFailure(t *testing.T) {
	d, restartCalls := newAutoUpdateTestDaemon(t, "v0.1.13")
	withStubRelease(t, &cli.GitHubRelease{TagName: "v0.1.14"}, nil)

	d.runUpdateFn = func(string) (string, error) {
		return "brew: network error", errors.New("brew upgrade failed")
	}

	d.tryAutoUpdate(context.Background())

	if restartCalls.Load() != 0 {
		t.Fatalf("triggerRestart fired despite upgrade failure")
	}
	if d.updating.Load() {
		t.Fatalf("updating flag must be released after a failed upgrade so the next tick can retry")
	}
}

func TestAutoUpdateLoop_EarlyExits(t *testing.T) {
	tests := []struct {
		name string
		cfg  Config
	}{
		{
			name: "disabled by config",
			cfg:  Config{AutoUpdateEnabled: false, CLIVersion: "v0.1.13"},
		},
		{
			name: "managed by desktop",
			cfg:  Config{AutoUpdateEnabled: true, CLIVersion: "v0.1.13", LaunchedBy: "desktop"},
		},
		{
			name: "dev build",
			cfg:  Config{AutoUpdateEnabled: true, CLIVersion: "v0.1.13-235-gabcdef0"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			d := &Daemon{cfg: tt.cfg, logger: slog.Default()}
			d.runUpdateFn = func(string) (string, error) {
				t.Fatalf("runUpdateFn called from an early-exit code path")
				return "", nil
			}
			withStubRelease(t, &cli.GitHubRelease{TagName: "v0.1.14"}, nil)

			done := make(chan struct{})
			go func() {
				d.autoUpdateLoop(context.Background())
				close(done)
			}()
			<-done
		})
	}
}
