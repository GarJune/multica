package jira

import (
	"strings"
)

func MapStatus(status Status) string {
	switch strings.ToLower(status.StatusCategory.Key) {
	case "new":
		return "todo"
	case "indeterminate":
		return "in_progress"
	case "done":
		return "done"
	default:
		return "in_progress"
	}
}

func MapPriority(priority *Priority) string {
	if priority == nil {
		return "none"
	}
	switch strings.ToLower(strings.TrimSpace(priority.Name)) {
	case "highest", "critical", "blocker":
		return "urgent"
	case "high":
		return "high"
	case "medium":
		return "medium"
	case "low", "lowest", "minor":
		return "low"
	default:
		return "none"
	}
}

func DescriptionToText(description any) string {
	switch v := description.(type) {
	case nil:
		return ""
	case string:
		return v
	case map[string]any:
		var parts []string
		extractADFText(v, &parts)
		return strings.Join(parts, "\n")
	default:
		return ""
	}
}

// extractADFText recursively walks an ADF node and appends text segments to parts.
// A new line starts after block-level nodes (paragraph, listItem).
func extractADFText(node map[string]any, parts *[]string) {
	// If this node has text content, append it to the current line segment.
	if text, ok := node["text"].(string); ok && text != "" {
		if len(*parts) == 0 {
			*parts = append(*parts, text)
		} else {
			last := len(*parts) - 1
			(*parts)[last] += text
		}
		return
	}

	contentRaw, ok := node["content"]
	if !ok {
		return
	}
	content, ok := contentRaw.([]any)
	if !ok {
		return
	}

	for _, child := range content {
		childNode, ok := child.(map[string]any)
		if !ok {
			continue
		}

		nodeType, _ := childNode["type"].(string)
		startsOwnLine := nodeType == "paragraph" || nodeType == "heading"
		if startsOwnLine {
			*parts = append(*parts, "")
		}

		extractADFText(childNode, parts)

		if startsOwnLine {
			// Trim trailing whitespace on the newly-completed block.
			last := len(*parts) - 1
			if last >= 0 {
				(*parts)[last] = strings.TrimSpace((*parts)[last])
			}
		}
	}
}
