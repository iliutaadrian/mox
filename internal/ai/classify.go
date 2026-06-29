// Package ai classifies emails into the user's fixed category set using OpenAI.
//
// The result is local-only metadata (see package store) — nothing is ever
// written back to the mail server. Classification uses a single function
// (tool) call that returns one result per email (batched), an enum-constrained
// category field so the model picks from the fixed set, and a suggested_new
// field for emails that fit none of them. The system prompt is byte-stable
// across runs so it hits OpenAI's automatic prompt cache.
package ai

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/iliutaadrian/spark-cli/internal/config"
	"github.com/iliutaadrian/spark-cli/internal/store"
)

// MaxBatch is the most emails sent in one classification request.
const MaxBatch = 20

// bodyLimit caps how many characters of each email body are sent to the model.
const bodyLimit = 2000

// apiURL is the OpenAI Chat Completions endpoint.
const apiURL = "https://api.openai.com/v1/chat/completions"

// Result is one classified email, keyed back to the input by Index.
type Result struct {
	Index        int    `json:"index"`
	Category     string `json:"category"`
	Confidence   string `json:"confidence"`
	SuggestedNew string `json:"suggested_new"`
}

type envelope struct {
	Results []Result `json:"results"`
}

// Classifier holds the OpenAI credentials, model, and HTTP client.
type Classifier struct {
	apiKey string
	model  string
	http   *http.Client
}

// New builds a Classifier. apiKey may be empty to fall back to OPENAI_API_KEY.
func New(apiKey, model string) *Classifier {
	return &Classifier{
		apiKey: apiKey,
		model:  model,
		http:   http.DefaultClient,
	}
}

// --- request/response shapes for the OpenAI Chat Completions API ---

type chatMessage struct {
	Role      string     `json:"role"`
	Content   string     `json:"content,omitempty"`
	ToolCalls []toolCall `json:"tool_calls,omitempty"`
}

type toolCall struct {
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type chatRequest struct {
	Model      string        `json:"model"`
	MaxTokens  int           `json:"max_tokens"`
	Messages   []chatMessage `json:"messages"`
	Tools      []any         `json:"tools"`
	ToolChoice any           `json:"tool_choice"`
}

type chatResponse struct {
	Choices []struct {
		Message chatMessage `json:"message"`
	} `json:"choices"`
	Error *struct {
		Message string `json:"message"`
		Type    string `json:"type"`
	} `json:"error"`
}

// Classify sends up to MaxBatch messages and returns a result per message,
// aligned to the input slice order. cats is the current fixed category set.
func (c *Classifier) Classify(ctx context.Context, cats []config.Category, msgs []store.Message) ([]Result, error) {
	if len(msgs) == 0 {
		return nil, nil
	}
	if len(msgs) > MaxBatch {
		msgs = msgs[:MaxBatch]
	}

	catNames := make([]string, len(cats))
	for i, cat := range cats {
		catNames[i] = cat.Name
	}

	// JSON Schema for the classify_emails function's arguments.
	parameters := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"results": map[string]any{
				"type":        "array",
				"description": "One entry per email, identified by its index.",
				"items": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"index":      map[string]any{"type": "integer", "description": "The email's index from the prompt."},
						"category":   map[string]any{"type": "string", "enum": catNames, "description": "The best-fitting category from the fixed set."},
						"confidence": map[string]any{"type": "string", "enum": []string{"high", "medium", "low"}},
						"suggested_new": map[string]any{
							"type":        "string",
							"description": "Leave empty unless NONE of the fixed categories fit. If so, propose a short Title-Case name for a new category and still set `category` to your closest guess.",
						},
					},
					"required": []string{"index", "category", "confidence"},
				},
			},
		},
		"required": []string{"results"},
	}

	tool := map[string]any{
		"type": "function",
		"function": map[string]any{
			"name":        "classify_emails",
			"description": "Record the category for each email in the batch.",
			"parameters":  parameters,
		},
	}

	reqBody := chatRequest{
		Model:     c.model,
		MaxTokens: 2048,
		Messages: []chatMessage{
			{Role: "system", Content: systemPrompt(cats)},
			{Role: "user", Content: userPrompt(msgs)},
		},
		Tools: []any{tool},
		ToolChoice: map[string]any{
			"type":     "function",
			"function": map[string]any{"name": "classify_emails"},
		},
	}

	payload, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("classify: marshal request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, apiURL, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("classify: build request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.apiKey)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("classify: %w", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("classify: read response: %w", err)
	}

	var cr chatResponse
	if err := json.Unmarshal(raw, &cr); err != nil {
		return nil, fmt.Errorf("classify: parse response: %w (body: %s)", err, truncate(string(raw), 300))
	}
	if cr.Error != nil {
		return nil, fmt.Errorf("classify: openai error: %s", cr.Error.Message)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("classify: openai http %d: %s", resp.StatusCode, truncate(string(raw), 300))
	}
	if len(cr.Choices) == 0 || len(cr.Choices[0].Message.ToolCalls) == 0 {
		return nil, fmt.Errorf("classify: model returned no tool call")
	}

	var env envelope
	if err := json.Unmarshal([]byte(cr.Choices[0].Message.ToolCalls[0].Function.Arguments), &env); err != nil {
		return nil, fmt.Errorf("classify: parse tool arguments: %w", err)
	}
	return env.Results, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func systemPrompt(cats []config.Category) string {
	var b strings.Builder
	b.WriteString(`You sort incoming emails into a fixed set of categories for a personal terminal email client, in the spirit of Spark's Smart Inbox. This is a display grouping only — you are not labeling the mailbox.

For each email, pick the single best-fitting category from the list below. If — and only if — none of them genuinely fit, propose a new category name in the suggested_new field (Title Case, 1-2 words) and still set category to your closest guess.

Categories:
`)
	for _, cat := range cats {
		if cat.Description != "" {
			fmt.Fprintf(&b, "- %s: %s\n", cat.Name, cat.Description)
		} else {
			fmt.Fprintf(&b, "- %s\n", cat.Name)
		}
	}
	b.WriteString("\nReturn your answer by calling the classify_emails tool with one result per email, using each email's index.")
	return b.String()
}

func userPrompt(msgs []store.Message) string {
	var b strings.Builder
	b.WriteString("Classify these emails:\n\n")
	for i, m := range msgs {
		body := m.Body
		if body == "" {
			body = m.Snippet
		}
		if len(body) > bodyLimit {
			body = body[:bodyLimit]
		}
		fmt.Fprintf(&b, "=== Email %d ===\nFrom: %s <%s>\nSubject: %s\n\n%s\n\n", i, m.FromName, m.FromAddr, m.Subject, body)
	}
	return b.String()
}
