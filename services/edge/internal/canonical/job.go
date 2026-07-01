// Package canonical defines the ReviewJob — the single, strict schema that the
// edge normalizes every inbound webhook into. Nothing downstream of the edge
// ever sees a raw GitHub payload; it sees only this. Keeping the schema narrow
// and explicit is a security control: hostile or malformed fields are dropped
// at the boundary instead of propagating into the orchestrator.
package canonical

// SchemaVersion is bumped when the ReviewJob shape changes in a breaking way.
// Consumers (the orchestrator) assert on it so a version skew fails loudly
// instead of silently mis-parsing.
const SchemaVersion = "1"

// ReviewJob is the canonical unit of work that flows edge → queue → orchestrator.
type ReviewJob struct {
	SchemaVersion string `json:"schema_version"`

	// IdempotencyKey deduplicates logically-identical work. Two deliveries that
	// describe the same (repo, PR, action, head commit) collapse to one job.
	IdempotencyKey string `json:"idempotency_key"`

	// DeliveryID is GitHub's X-GitHub-Delivery — useful for tracing a job back
	// to the exact webhook delivery, but NOT used for dedupe (redeliveries of
	// the same logical event get fresh delivery IDs).
	DeliveryID string `json:"delivery_id"`

	Org            string `json:"org"`             // owner login (e.g. "acme")
	Repo           string `json:"repo"`            // full name "owner/name"
	RepoID         int64  `json:"repo_id"`         // stable numeric repo id
	PRNumber       int    `json:"pr_number"`       // pull request number
	Action         string `json:"action"`          // opened|synchronize|reopened|ready_for_review
	HeadSHA        string `json:"head_sha"`        // commit to review
	BaseSHA        string `json:"base_sha"`        // merge base side
	InstallationID int64  `json:"installation_id"` // GitHub App installation (for token mint)

	// Priority orders work in the queue; lower = more urgent. Phase 0 uses a
	// single default; Stage 0's priority queue will set this (security PRs jump).
	Priority int `json:"priority"`

	Title      string `json:"title"`
	Author     string `json:"author"`
	EnqueuedAt string `json:"enqueued_at"` // RFC3339, set at enqueue time

	// Trigger tells the orchestrator WHY this job exists:
	//   "pull_request" — an automatic review (opened/synchronize/…)
	//   "command"      — a human typed "@cavix <command>" on the PR
	Trigger string `json:"trigger"`

	// Command fields are set only when Trigger == "command".
	Command           string `json:"command,omitempty"`            // review|resolve|pause|resume|help|summary|ask
	CommandArgs       string `json:"command_args,omitempty"`       // free text (e.g. an "ask" question or flags)
	CommentID         int64  `json:"comment_id,omitempty"`         // the comment that issued the command
	AuthorAssociation string `json:"author_association,omitempty"` // OWNER|MEMBER|COLLABORATOR|…

	// ForceFresh asks the orchestrator to discard the incremental cache and any
	// stale bot reviews, then review from scratch. Set by "@cavix review".
	ForceFresh bool `json:"force_fresh,omitempty"`
}

// DefaultPriority is the baseline urgency for an ordinary PR.
const DefaultPriority = 100

// Trigger values.
const (
	TriggerPullRequest = "pull_request"
	TriggerCommand     = "command"
)
