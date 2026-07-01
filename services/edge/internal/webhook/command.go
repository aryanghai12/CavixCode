package webhook

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/cavix/edge/internal/canonical"
)

// Command handling: a human types "@cavix review" (or resolve/pause/…) on a PR.
// GitHub delivers that as an `issue_comment` event. We parse the command, confirm
// it targets a pull request, and turn it into a command ReviewJob. Command jobs
// are ALWAYS fresh (never deduped) so re-invoking review re-reviews.

// Recognized commands and their aliases → canonical name.
var commandAliases = map[string]string{
	"review":    "review",
	"re-review": "review",
	"rereview":  "review",
	"full":      "review",
	"resolve":   "resolve",
	"dismiss":   "resolve",
	"pause":     "pause",
	"stop":      "pause",
	"resume":    "resume",
	"start":     "resume",
	"help":      "help",
	"summary":   "summary",
	"summarize": "summary",
	"ask":       "ask",
	"configure": "configure",
}

// ParsedCommand is a recognized "@handle <cmd> [args]" instruction.
type ParsedCommand struct {
	Name string
	Args string
}

// ParseCommand finds "@<handle> <command> [args]" in a comment body.
// Rules: a recognized command → that command; a mention followed by other text →
// "ask" (free-text Q&A); a bare mention → "help". Returns ok=false if the bot is
// not mentioned at all.
func ParseCommand(body, handle string) (ParsedCommand, bool) {
	// Match "@handle" (case-insensitive), then capture the rest of that line.
	re := regexp.MustCompile(`(?i)@` + regexp.QuoteMeta(handle) + `\b[ \t]*([^\r\n]*)`)
	m := re.FindStringSubmatch(body)
	if m == nil {
		return ParsedCommand{}, false
	}
	rest := strings.TrimSpace(m[1])
	if rest == "" {
		return ParsedCommand{Name: "help"}, true
	}
	fields := strings.Fields(rest)
	first := strings.ToLower(strings.TrimLeft(fields[0], "-/"))
	if canon, ok := commandAliases[first]; ok {
		args := strings.TrimSpace(strings.TrimPrefix(rest, fields[0]))
		return ParsedCommand{Name: canon, Args: args}, true
	}
	// Mention + free text that isn't a known command → treat as a question.
	return ParsedCommand{Name: "ask", Args: rest}, true
}

type issueCommentEvent struct {
	Action string `json:"action"`
	Issue  struct {
		Number      int    `json:"number"`
		Title       string `json:"title"`
		PullRequest *struct {
			URL string `json:"url"`
		} `json:"pull_request"`
	} `json:"issue"`
	Comment struct {
		ID                int64  `json:"id"`
		Body              string `json:"body"`
		AuthorAssociation string `json:"author_association"`
		User              struct {
			Login string `json:"login"`
		} `json:"user"`
	} `json:"comment"`
	Repository struct {
		ID       int64  `json:"id"`
		FullName string `json:"full_name"`
		Owner    struct {
			Login string `json:"login"`
		} `json:"owner"`
	} `json:"repository"`
	Installation struct {
		ID int64 `json:"id"`
	} `json:"installation"`
}

// NormalizeIssueComment turns an issue_comment webhook into a command ReviewJob,
// or returns ErrNotTrigger if it isn't a Cavix command on a pull request.
func NormalizeIssueComment(body []byte, deliveryID, handle string) (canonical.ReviewJob, error) {
	var ev issueCommentEvent
	if err := json.Unmarshal(body, &ev); err != nil {
		return canonical.ReviewJob{}, fmt.Errorf("decode issue_comment payload: %w", err)
	}
	if ev.Action != "created" {
		return canonical.ReviewJob{}, ErrNotTrigger // ignore edited/deleted
	}
	if ev.Issue.PullRequest == nil {
		return canonical.ReviewJob{}, ErrNotTrigger // a plain issue, not a PR
	}
	cmd, ok := ParseCommand(ev.Comment.Body, handle)
	if !ok {
		return canonical.ReviewJob{}, ErrNotTrigger // bot not mentioned
	}
	if ev.Repository.ID == 0 || ev.Issue.Number == 0 {
		return canonical.ReviewJob{}, fmt.Errorf("issue_comment missing repo id / issue number")
	}

	org := ev.Repository.Owner.Login
	if org == "" {
		if i := strings.IndexByte(ev.Repository.FullName, '/'); i > 0 {
			org = ev.Repository.FullName[:i]
		}
	}

	job := canonical.ReviewJob{
		SchemaVersion:     canonical.SchemaVersion,
		DeliveryID:        deliveryID,
		Org:               org,
		Repo:              ev.Repository.FullName,
		RepoID:            ev.Repository.ID,
		PRNumber:          ev.Issue.Number,
		Action:            "command",
		InstallationID:    ev.Installation.ID,
		Priority:          canonical.DefaultPriority - 10, // human-invoked → slightly higher priority
		Title:             ev.Issue.Title,
		Author:            ev.Comment.User.Login,
		EnqueuedAt:        time.Now().UTC().Format(time.RFC3339),
		Trigger:           canonical.TriggerCommand,
		Command:           cmd.Name,
		CommandArgs:       cmd.Args,
		CommentID:         ev.Comment.ID,
		AuthorAssociation: ev.Comment.AuthorAssociation,
		ForceFresh:        cmd.Name == "review", // explicit review → fresh, dismiss stale
	}
	// Unique per comment so a command is NEVER deduped — each invocation runs.
	job.IdempotencyKey = commandIdempotencyKey(job)
	return job, nil
}

func commandIdempotencyKey(j canonical.ReviewJob) string {
	h := sha256.New()
	fmt.Fprintf(h, "cmd|%d|%d|%s|%d", j.RepoID, j.PRNumber, j.Command, j.CommentID)
	return hex.EncodeToString(h.Sum(nil))
}

// DefaultAllowedAssociations may trigger commands (prevents drive-by abuse).
var DefaultAllowedAssociations = map[string]bool{
	"OWNER":        true,
	"MEMBER":       true,
	"COLLABORATOR": true,
}

// IsAuthorized reports whether a comment author may run commands.
func IsAuthorized(association string, allowed map[string]bool) bool {
	if allowed == nil {
		allowed = DefaultAllowedAssociations
	}
	return allowed[strings.ToUpper(association)]
}
