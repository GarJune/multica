package jira

import "testing"

func TestMapStatusCategory(t *testing.T) {
	tests := []struct {
		name string
		in   Status
		want string
	}{
		{name: "todo", in: Status{StatusCategory: StatusCategory{Key: "new", Name: "To Do"}}, want: "todo"},
		{name: "in progress", in: Status{StatusCategory: StatusCategory{Key: "indeterminate", Name: "In Progress"}}, want: "in_progress"},
		{name: "done", in: Status{StatusCategory: StatusCategory{Key: "done", Name: "Done"}}, want: "done"},
		{name: "unknown", in: Status{Name: "Blocked", StatusCategory: StatusCategory{Key: "custom", Name: "Custom"}}, want: "in_progress"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := MapStatus(tt.in); got != tt.want {
				t.Fatalf("MapStatus() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestMapPriority(t *testing.T) {
	tests := []struct {
		name string
		in   *Priority
		want string
	}{
		{name: "highest", in: &Priority{Name: "Highest"}, want: "urgent"},
		{name: "critical", in: &Priority{Name: "Critical"}, want: "urgent"},
		{name: "blocker", in: &Priority{Name: "Blocker"}, want: "urgent"},
		{name: "high", in: &Priority{Name: "High"}, want: "high"},
		{name: "medium", in: &Priority{Name: "Medium"}, want: "medium"},
		{name: "low", in: &Priority{Name: "Low"}, want: "low"},
		{name: "lowest", in: &Priority{Name: "Lowest"}, want: "low"},
		{name: "minor", in: &Priority{Name: "Minor"}, want: "low"},
		{name: "nil", in: nil, want: "none"},
		{name: "unknown", in: &Priority{Name: "Trivial"}, want: "none"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := MapPriority(tt.in); got != tt.want {
				t.Fatalf("MapPriority() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestDescriptionToText(t *testing.T) {
	desc := map[string]any{
		"type": "doc",
		"content": []any{
			map[string]any{
				"type": "paragraph",
				"content": []any{
					map[string]any{"type": "text", "text": "Fix"},
					map[string]any{"type": "text", "text": " callback"},
				},
			},
			map[string]any{
				"type": "bulletList",
				"content": []any{
					map[string]any{
						"type": "listItem",
						"content": []any{
							map[string]any{
								"type":    "paragraph",
								"content": []any{map[string]any{"type": "text", "text": "Retry"}},
							},
						},
					},
				},
			},
		},
	}

	got := DescriptionToText(desc)
	if got != "Fix callback\nRetry" {
		t.Fatalf("DescriptionToText() = %q", got)
	}
}

func TestDescriptionToTextHandlesStringAndMalformedValues(t *testing.T) {
	if got := DescriptionToText("plain wiki text"); got != "plain wiki text" {
		t.Fatalf("string description = %q", got)
	}
	if got := DescriptionToText(map[string]any{"content": "not an array"}); got != "" {
		t.Fatalf("malformed description = %q, want empty", got)
	}
	if got := DescriptionToText(nil); got != "" {
		t.Fatalf("nil description = %q, want empty", got)
	}
}
