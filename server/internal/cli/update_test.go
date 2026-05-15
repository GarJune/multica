package cli

import (
	"testing"
	"time"
)

func TestReleaseAssetCandidates(t *testing.T) {
	tests := []struct {
		name          string
		targetVersion string
		goos          string
		goarch        string
		wantAssets    []string
	}{
		{
			name:          "darwin prefers versioned then legacy candidate",
			targetVersion: "v1.2.3",
			goos:          "darwin",
			goarch:        "arm64",
			wantAssets: []string{
				"multica-cli-1.2.3-darwin-arm64.tar.gz",
				"multica_darwin_arm64.tar.gz",
			},
		},
		{
			name:          "linux normalizes missing v in versioned candidate",
			targetVersion: "1.2.3",
			goos:          "linux",
			goarch:        "amd64",
			wantAssets: []string{
				"multica-cli-1.2.3-linux-amd64.tar.gz",
				"multica_linux_amd64.tar.gz",
			},
		},
		{
			name:          "windows uses zip assets",
			targetVersion: "1.2.3",
			goos:          "windows",
			goarch:        "amd64",
			wantAssets: []string{
				"multica-cli-1.2.3-windows-amd64.zip",
				"multica_windows_amd64.zip",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := releaseAssetCandidates(tt.targetVersion, tt.goos, tt.goarch)
			if len(got) != len(tt.wantAssets) {
				t.Fatalf("candidate count mismatch: got %d, want %d", len(got), len(tt.wantAssets))
			}
			for i := range got {
				if got[i] != tt.wantAssets[i] {
					t.Fatalf("candidate[%d] mismatch: got %q, want %q", i, got[i], tt.wantAssets[i])
				}
			}
		})
	}
}

func TestFindReleaseAsset(t *testing.T) {
	t.Run("prefers versioned asset when both names exist", func(t *testing.T) {
		assets := []GitHubReleaseAsset{
			{Name: "multica_darwin_amd64.tar.gz", BrowserDownloadURL: "old"},
			{Name: "multica-cli-1.2.3-darwin-amd64.tar.gz", BrowserDownloadURL: "new"},
		}

		got, err := findReleaseAsset(assets, "v1.2.3", "darwin", "amd64")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Name != "multica-cli-1.2.3-darwin-amd64.tar.gz" {
			t.Fatalf("asset mismatch: got %q", got.Name)
		}
	})

	t.Run("falls back to legacy asset when versioned is absent", func(t *testing.T) {
		assets := []GitHubReleaseAsset{
			{Name: "multica_linux_amd64.tar.gz", BrowserDownloadURL: "old"},
		}

		got, err := findReleaseAsset(assets, "1.2.3", "linux", "amd64")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if got.Name != "multica_linux_amd64.tar.gz" {
			t.Fatalf("asset mismatch: got %q", got.Name)
		}
	})

	t.Run("returns error when no candidate matches", func(t *testing.T) {
		_, err := findReleaseAsset([]GitHubReleaseAsset{{Name: "checksums.txt"}}, "1.2.3", "linux", "amd64")
		if err == nil {
			t.Fatal("expected error, got nil")
		}
	})
}

func TestIsReleaseVersion(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want bool
	}{
		{"bare release", "0.1.13", true},
		{"v-prefixed release", "v0.1.13", true},
		{"surrounding whitespace", "  v0.1.13  ", true},
		{"dev describe", "v0.2.15-235-gdaf0e935", false},
		{"dirty dev describe", "v0.2.15-235-gdaf0e935-dirty", false},
		{"empty", "", false},
		{"two components", "0.1", false},
		{"four components", "0.1.2.3", false},
		{"non-numeric", "1.0.x", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsReleaseVersion(tt.in); got != tt.want {
				t.Fatalf("IsReleaseVersion(%q) = %v, want %v", tt.in, got, tt.want)
			}
		})
	}
}

func TestIsNewerVersion(t *testing.T) {
	tests := []struct {
		name            string
		latest, current string
		want            bool
	}{
		{"patch bump", "v0.1.14", "v0.1.13", true},
		{"minor bump", "v0.2.0", "v0.1.99", true},
		{"major bump", "v1.0.0", "v0.99.99", true},
		{"same version", "v0.1.13", "v0.1.13", false},
		{"older latest", "v0.1.12", "v0.1.13", false},
		{"mixed v prefix", "0.1.14", "v0.1.13", true},
		{"current is dev describe → not newer", "v0.1.14", "v0.1.13-5-gabcdef0", true},
		{"latest unparseable → false", "garbage", "v0.1.13", false},
		{"current unparseable → false", "v0.1.14", "garbage", false},
		{"empty latest", "", "v0.1.13", false},
		{"empty current", "v0.1.14", "", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsNewerVersion(tt.latest, tt.current); got != tt.want {
				t.Fatalf("IsNewerVersion(%q, %q) = %v, want %v", tt.latest, tt.current, got, tt.want)
			}
		})
	}
}

func TestUpdateDownloadTimeoutOrDefault(t *testing.T) {
	tests := []struct {
		name    string
		timeout time.Duration
		want    time.Duration
	}{
		{
			name:    "uses default for zero",
			timeout: 0,
			want:    DefaultUpdateDownloadTimeout,
		},
		{
			name:    "uses default for negative",
			timeout: -1 * time.Second,
			want:    DefaultUpdateDownloadTimeout,
		},
		{
			name:    "keeps explicit timeout",
			timeout: 10 * time.Minute,
			want:    10 * time.Minute,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := updateDownloadTimeoutOrDefault(tt.timeout)
			if got != tt.want {
				t.Fatalf("timeout = %s, want %s", got, tt.want)
			}
		})
	}
}
