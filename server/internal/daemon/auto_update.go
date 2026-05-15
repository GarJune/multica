package daemon

import (
	"context"
	"time"

	"github.com/multica-ai/multica/server/internal/cli"
)

// Indirections over the real release / version helpers so tests can run the
// auto-update loop deterministically without reaching out to GitHub or
// shelling out to brew/curl. Mirrors the pattern used at the top of daemon.go
// for `isBrewInstall` / `getBrewPrefix` / `matchKnownBrewPrefix`.
var (
	fetchLatestRelease = cli.FetchLatestRelease
	isReleaseVersion   = cli.IsReleaseVersion
	isNewerVersion     = cli.IsNewerVersion
)

// autoUpdateInitialDelay is how long the loop waits after Run() returns before
// performing its first version check. The daemon has plenty to do at startup
// (auth, register, sync workspaces, kick off heartbeats); we don't want to add
// an outbound HTTPS call to GitHub on top of that. The delay is also short
// enough that a brand-new install with an available update still self-updates
// within a couple of minutes rather than after the full check interval.
var autoUpdateInitialDelay = 2 * time.Minute

// autoUpdateLoop periodically polls GitHub for a newer CLI release and, when
// one is available and the daemon is idle, runs the same brew-or-download
// upgrade path as the server-triggered update. On success it triggers a
// graceful restart into the new binary.
//
// Disabled when:
//   - the operator opted out via --no-auto-update / MULTICA_DAEMON_AUTO_UPDATE=false;
//   - the daemon was spawned by Desktop (the Electron app owns the binary);
//   - the running version doesn't look like a tagged release (dev builds).
//
// Each tick is silent on the happy path of "already on latest" so the log
// stays uncluttered for users who run the daemon for weeks at a time.
func (d *Daemon) autoUpdateLoop(ctx context.Context) {
	if !d.cfg.AutoUpdateEnabled {
		d.logger.Info("auto-update: disabled")
		return
	}
	if d.cfg.LaunchedBy == "desktop" {
		// Desktop ships and replaces the CLI binary itself; self-update would
		// be clobbered on the next launch. Stay quiet but don't run.
		d.logger.Info("auto-update: skipped (managed by Desktop)")
		return
	}
	if !isReleaseVersion(d.cfg.CLIVersion) {
		// Source builds (`make daemon`) and ad-hoc builds report a
		// `git describe`-style version; auto-upgrading them to a public
		// release would silently downgrade the dev work checked out on the
		// machine. Skip and let the developer drive their own version.
		d.logger.Info("auto-update: skipped (not a release build)", "version", d.cfg.CLIVersion)
		return
	}

	interval := d.cfg.AutoUpdateCheckInterval
	if interval <= 0 {
		interval = DefaultAutoUpdateCheckInterval
	}
	d.logger.Info("auto-update: started", "interval", interval, "current", d.cfg.CLIVersion)

	if err := sleepWithContext(ctx, autoUpdateInitialDelay); err != nil {
		return
	}
	d.tryAutoUpdate(ctx)

	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			d.tryAutoUpdate(ctx)
		}
	}
}

// tryAutoUpdate runs one check-and-maybe-upgrade cycle. Bails early on any of:
// already updating (server-triggered upgrade in flight), active tasks (defer
// to next tick — we never interrupt running agents), version fetch failure,
// or no newer release. The function never returns an error: a check that
// fails today will be retried at the next tick, and we don't want a transient
// network blip to escalate to a process-level shutdown.
func (d *Daemon) tryAutoUpdate(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	// Don't race the server-triggered update path. If a manual update from
	// the Runtimes page is already in flight, let it finish and re-check next
	// tick (by which time we'll either be on the new binary or it failed and
	// we can retry).
	if d.updating.Load() {
		d.logger.Debug("auto-update: skip — update already in progress")
		return
	}
	// "Idle" = no in-flight tasks. handleTask increments activeTasks before
	// the goroutine runs and decrements after it returns, so checking this
	// before claiming the `updating` CAS is the right ordering: a task that
	// starts the instant after we pass the check would have to grab a
	// pollLoop slot, and the daemon's restart cancels ctx anyway. The narrow
	// race (task starts between the load and the upgrade kicking off) is
	// acceptable — handleTask runs under d.rootCtx, not the run ctx that
	// triggerRestart cancels, so an in-flight task continues even across
	// the restart kick (see runRuntimePoller's parentCtx).
	if running := d.activeTasks.Load(); running > 0 {
		d.logger.Debug("auto-update: skip — tasks running", "active", running)
		return
	}

	release, err := fetchLatestRelease()
	if err != nil {
		d.logger.Warn("auto-update: fetch latest release failed — will retry", "error", err)
		return
	}
	if release == nil || release.TagName == "" {
		return
	}
	if !isNewerVersion(release.TagName, d.cfg.CLIVersion) {
		return
	}

	// CAS the updating flag so a concurrent server-triggered handleUpdate
	// dropped onto a heartbeat tick can't double-fire. Release on every exit
	// path before triggerRestart — once that lands, the daemon ctx is
	// cancelled and the flag dies with the process.
	if !d.updating.CompareAndSwap(false, true) {
		d.logger.Debug("auto-update: skip — update already in progress (raced)")
		return
	}
	released := false
	defer func() {
		if !released {
			d.updating.Store(false)
		}
	}()

	d.logger.Info("auto-update: newer release available, upgrading",
		"current", d.cfg.CLIVersion, "target", release.TagName)

	output, err := d.runUpdateFn(release.TagName)
	if err != nil {
		d.logger.Warn("auto-update: upgrade failed — will retry", "error", err, "output", output)
		return
	}

	d.logger.Info("auto-update: upgrade completed, restarting", "target", release.TagName, "output", output)
	// triggerRestart cancels the root context, which causes Run() to return
	// and the parent (cmd_daemon.go) to re-exec the new binary. Leave the
	// `updating` flag held — process exit is imminent and clearing it would
	// open a window for another loop iteration to fire mid-shutdown.
	released = true
	d.triggerRestart()
}
