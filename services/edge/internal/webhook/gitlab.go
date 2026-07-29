package webhook

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/cavix/edge/internal/canonical"
)

// GitLab ingestion, normalized into the SAME canonical ReviewJob GitHub
// produces. Nothing downstream of this file knows which host a job came from
// except by reading job.Platform, which is the point: the orchestrator's
// workflow does not branch on platform, and neither does the queue.
//
// TWO THINGS ARE GENUINELY DIFFERENT HERE, and both are security-relevant:
//
//  1. GitLab does not sign the body. It sends a shared secret verbatim in
//     X-Gitlab-Token, so there is no HMAC to recompute and no way to bind the
//     token to the payload. The comparison is still constant-time (a token is
//     a secret and a timing oracle on it is a real leak), but the honest
//     statement is that this is weaker than GitHub's scheme: anyone who learns
//     the token can forge any body. It is what the platform offers.
//
//  2. GitLab has no installation id. GitHub mints a short-lived token per
//     install; GitLab authenticates with a token held per workspace, so
//     InstallationID stays 0 and the orchestrator resolves credentials from the
//     control-plane by org instead.

// GitLabTokenHeader carries the shared secret configured on the project hook.
const GitLabTokenHeader = "X-Gitlab-Token"

// GitLabEventHeader names the event, e.g. "Merge Request Hook".
const GitLabEventHeader = "X-Gitlab-Event"

// VerifyGitLabToken reports whether the presented token matches the configured
// one, in constant time.
//
// An empty configured secret returns false, the same fail-closed default as the
// GitHub path: refusing to "verify" against no secret is what stops a
// misconfigured deploy from silently accepting anonymous traffic.
func VerifyGitLabToken(secret, presented string) bool {
	if secret == "" || presented == "" {
		return false
	}
	// Compare digests rather than the raw strings so the comparison is over a
	// fixed length: subtle.ConstantTimeCompare returns 0 immediately for a
	// length mismatch, which leaks the secret's length.
	want := sha256.Sum256([]byte(secret))
	got := sha256.Sum256([]byte(presented))
	return subtle.ConstantTimeCompare(want[:], got[:]) == 1
}

// gitlabMergeRequestEvent is the strict subset of GitLab's Merge Request Hook
// payload we consume. Same allow-list discipline as the GitHub normalizer.
type gitlabMergeRequestEvent struct {
	ObjectKind string `json:"object_kind"`
	User       struct {
		Username string `json:"username"`
	} `json:"user"`
	Project struct {
		ID                int64  `json:"id"`
		PathWithNamespace string `json:"path_with_namespace"`
		Namespace         string `json:"namespace"`
	} `json:"project"`
	ObjectAttributes struct {
		IID          int    `json:"iid"`
		Title        string `json:"title"`
		Action       string `json:"action"`
		State        string `json:"state"`
		TargetBranch string `json:"target_branch"`
		LastCommit   struct {
			ID string `json:"id"`
		} `json:"last_commit"`
		WorkInProgress bool `json:"work_in_progress"`
		Draft          bool `json:"draft"`
	} `json:"object_attributes"`
}

// gitlabMergeActions are the merge-request actions worth a review. GitLab's
// vocabulary differs from GitHub's: "update" covers a new push AND a title
// edit, so the idempotency key (which binds to the head commit) is what stops a
// renamed MR from costing a second review.
var gitlabMergeActions = map[string]bool{
	"open":   true,
	"reopen": true,
	"update": true,
	"ready":  true, // draft lifted
}

// NormalizeGitLabMergeRequest converts a Merge Request Hook body into a job.
func NormalizeGitLabMergeRequest(body []byte, deliveryID string) (canonical.ReviewJob, error) {
	var ev gitlabMergeRequestEvent
	if err := json.Unmarshal(body, &ev); err != nil {
		return canonical.ReviewJob{}, fmt.Errorf("decode merge_request payload: %w", err)
	}
	if ev.ObjectKind != "merge_request" {
		return canonical.ReviewJob{}, ErrNotTrigger
	}
	if !gitlabMergeActions[ev.ObjectAttributes.Action] {
		return canonical.ReviewJob{}, ErrNotTrigger
	}
	// A merge request that is closing or merging is not a review candidate even
	// when the action says "update".
	if ev.ObjectAttributes.State == "closed" || ev.ObjectAttributes.State == "merged" {
		return canonical.ReviewJob{}, ErrNotTrigger
	}
	if ev.Project.ID == 0 || ev.ObjectAttributes.IID == 0 || ev.ObjectAttributes.LastCommit.ID == "" {
		return canonical.ReviewJob{}, errors.New("payload missing required fields (project id / iid / commit)")
	}

	full := ev.Project.PathWithNamespace
	if full == "" {
		return canonical.ReviewJob{}, errors.New("payload missing project path_with_namespace")
	}

	job := canonical.ReviewJob{
		SchemaVersion: canonical.SchemaVersion,
		Platform:      canonical.PlatformGitLab,
		DeliveryID:    deliveryID,
		// The workspace is the whole namespace, which on GitLab may be nested
		// ("acme/platform"). Taking only the first segment would file every
		// review in a subgroup under the wrong workspace.
		Org:      namespaceOf(full),
		Repo:     full,
		RepoID:   ev.Project.ID,
		PRNumber: ev.ObjectAttributes.IID,
		Action:   ev.ObjectAttributes.Action,
		HeadSHA:  ev.ObjectAttributes.LastCommit.ID,
		Priority: canonical.DefaultPriority,
		Title:    ev.ObjectAttributes.Title,
		Author:   ev.User.Username,
		// GitLab has no installation to mint a token from; credentials are held
		// per workspace in the control-plane.
		InstallationID: 0,
		EnqueuedAt:     time.Now().UTC().Format(time.RFC3339),
		Trigger:        canonical.TriggerPullRequest,
	}
	job.IdempotencyKey = idempotencyKey(job)
	return job, nil
}

// gitlabNoteEvent is the Note Hook payload: a comment somewhere. Only comments
// on a merge request can carry a command.
type gitlabNoteEvent struct {
	ObjectKind string `json:"object_kind"`
	User       struct {
		Username string `json:"username"`
	} `json:"user"`
	Project struct {
		ID                int64  `json:"id"`
		PathWithNamespace string `json:"path_with_namespace"`
	} `json:"project"`
	ObjectAttributes struct {
		ID           int64  `json:"id"`
		Note         string `json:"note"`
		NoteableType string `json:"noteable_type"`
	} `json:"object_attributes"`
	MergeRequest struct {
		IID        int    `json:"iid"`
		Title      string `json:"title"`
		State      string `json:"state"`
		LastCommit struct {
			ID string `json:"id"`
		} `json:"last_commit"`
	} `json:"merge_request"`
}

// NormalizeGitLabNote turns "@cavixcode <command>" on a merge request into a
// command job, reusing the exact parser the GitHub path uses so the two hosts
// can never drift on what a command means.
func NormalizeGitLabNote(body []byte, deliveryID, botHandle string) (canonical.ReviewJob, error) {
	var ev gitlabNoteEvent
	if err := json.Unmarshal(body, &ev); err != nil {
		return canonical.ReviewJob{}, fmt.Errorf("decode note payload: %w", err)
	}
	if ev.ObjectKind != "note" || !strings.EqualFold(ev.ObjectAttributes.NoteableType, "MergeRequest") {
		return canonical.ReviewJob{}, ErrNotTrigger
	}
	if ev.MergeRequest.IID == 0 || ev.Project.PathWithNamespace == "" {
		return canonical.ReviewJob{}, ErrNotTrigger
	}
	parsed, ok := ParseCommand(ev.ObjectAttributes.Note, botHandle)
	if !ok {
		return canonical.ReviewJob{}, ErrNotTrigger
	}

	full := ev.Project.PathWithNamespace
	job := canonical.ReviewJob{
		SchemaVersion: canonical.SchemaVersion,
		Platform:      canonical.PlatformGitLab,
		DeliveryID:    deliveryID,
		Org:           namespaceOf(full),
		Repo:          full,
		RepoID:        ev.Project.ID,
		PRNumber:      ev.MergeRequest.IID,
		Action:        "commented",
		// A note payload may or may not carry the MR's head commit. Empty is
		// expected and handled: the orchestrator resolves the current head
		// before it posts, exactly as it does for a GitHub issue_comment.
		HeadSHA:     ev.MergeRequest.LastCommit.ID,
		Priority:    canonical.DefaultPriority,
		Title:       ev.MergeRequest.Title,
		Author:      ev.User.Username,
		EnqueuedAt:  time.Now().UTC().Format(time.RFC3339),
		Trigger:     canonical.TriggerCommand,
		Command:     parsed.Name,
		CommandArgs: parsed.Args,
		CommentID:   ev.ObjectAttributes.ID,
		// GitLab does not report an author association on a note. Access is
		// therefore checked where it can actually be checked: the orchestrator
		// asks the API whether this user may push, rather than the edge
		// guessing from a field that is not there.
		AuthorAssociation: GitLabUnknownAssociation,
		ForceFresh:        parsed.Name == "review",
	}
	// Per-comment, so a second "@cavixcode review" on the same head is a second
	// review rather than a duplicate GitLab silently swallows.
	job.IdempotencyKey = commandKey(job)
	return job, nil
}

// GitLabUnknownAssociation marks a command whose author permission the edge
// could not establish. It is deliberately NOT one of the allowed associations,
// so the edge cannot authorize it; the orchestrator does that against the API.
const GitLabUnknownAssociation = "GITLAB_UNVERIFIED"

// namespaceOf returns everything before the final path segment, which is the
// GitLab namespace (possibly nested).
func namespaceOf(fullPath string) string {
	if i := strings.LastIndexByte(fullPath, '/'); i > 0 {
		return fullPath[:i]
	}
	return fullPath
}

// commandKey fingerprints a command invocation. Unlike a review job's key it
// includes the comment id, so each invocation is its own unit of work.
func commandKey(j canonical.ReviewJob) string {
	h := sha256.New()
	fmt.Fprintf(h, "%d|%d|cmd|%d|%s", j.RepoID, j.PRNumber, j.CommentID, j.Command)
	return hex.EncodeToString(h.Sum(nil))
}
