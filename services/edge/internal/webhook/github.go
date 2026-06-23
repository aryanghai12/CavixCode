package webhook

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/cavix/edge/internal/canonical"
)

// triggerActions are the pull_request actions worth a review. Other actions
// (labeled, assigned, closed, …) are acknowledged but produce no job.
var triggerActions = map[string]bool{
	"opened":           true,
	"synchronize":      true, // new commits pushed to the PR
	"reopened":         true,
	"ready_for_review": true,
}

// IsTriggerAction reports whether an action should produce a ReviewJob.
func IsTriggerAction(action string) bool { return triggerActions[action] }

// ErrNotTrigger signals a well-formed event we intentionally ignore.
var ErrNotTrigger = errors.New("pull_request action is not a review trigger")

// pullRequestEvent is the strict subset of GitHub's pull_request payload we
// consume. Unlisted fields are ignored by encoding/json — a deliberate
// allow-list so unexpected/hostile fields cannot reach downstream code.
type pullRequestEvent struct {
	Action      string `json:"action"`
	Number      int    `json:"number"`
	PullRequest struct {
		Title string `json:"title"`
		User  struct {
			Login string `json:"login"`
		} `json:"user"`
		Head struct {
			SHA string `json:"sha"`
		} `json:"head"`
		Base struct {
			SHA string `json:"sha"`
		} `json:"base"`
	} `json:"pull_request"`
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

// Normalize parses a raw pull_request webhook body and converts it into a
// canonical ReviewJob. deliveryID is GitHub's X-GitHub-Delivery header.
//
// It returns ErrNotTrigger for valid events whose action we don't review, so
// the caller can distinguish "ignore, ACK 202" from "malformed, reject".
func Normalize(body []byte, deliveryID string) (canonical.ReviewJob, error) {
	var ev pullRequestEvent
	if err := json.Unmarshal(body, &ev); err != nil {
		return canonical.ReviewJob{}, fmt.Errorf("decode pull_request payload: %w", err)
	}
	if !IsTriggerAction(ev.Action) {
		return canonical.ReviewJob{}, ErrNotTrigger
	}
	// Minimal integrity checks. A real PR event always carries these; their
	// absence means a malformed or spoofed-shape payload — reject it.
	if ev.Repository.ID == 0 || ev.Number == 0 || ev.PullRequest.Head.SHA == "" {
		return canonical.ReviewJob{}, errors.New("payload missing required fields (repo id / pr number / head sha)")
	}

	org := ev.Repository.Owner.Login
	if org == "" {
		// Fall back to the owner segment of full_name if owner.login is absent.
		if i := strings.IndexByte(ev.Repository.FullName, '/'); i > 0 {
			org = ev.Repository.FullName[:i]
		}
	}

	job := canonical.ReviewJob{
		SchemaVersion:  canonical.SchemaVersion,
		DeliveryID:     deliveryID,
		Org:            org,
		Repo:           ev.Repository.FullName,
		RepoID:         ev.Repository.ID,
		PRNumber:       ev.Number,
		Action:         ev.Action,
		HeadSHA:        ev.PullRequest.Head.SHA,
		BaseSHA:        ev.PullRequest.Base.SHA,
		InstallationID: ev.Installation.ID,
		Priority:       canonical.DefaultPriority,
		Title:          ev.PullRequest.Title,
		Author:         ev.PullRequest.User.Login,
		EnqueuedAt:     time.Now().UTC().Format(time.RFC3339),
	}
	job.IdempotencyKey = idempotencyKey(job)
	return job, nil
}

// idempotencyKey is the stable fingerprint of a logical unit of work. It binds
// to (repo, PR, action, head commit) so that:
//   - a redelivered "synchronize" for the same commit collapses to one review;
//   - a new commit (new head SHA) correctly produces a fresh review.
//
// It deliberately excludes DeliveryID and timestamps, which differ across
// redeliveries of the same logical event.
func idempotencyKey(j canonical.ReviewJob) string {
	h := sha256.New()
	fmt.Fprintf(h, "%d|%d|%s|%s", j.RepoID, j.PRNumber, j.Action, j.HeadSHA)
	return hex.EncodeToString(h.Sum(nil))
}
