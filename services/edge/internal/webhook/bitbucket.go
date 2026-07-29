package webhook

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/cavix/edge/internal/canonical"
)

// Bitbucket Cloud ingestion, normalized into the same canonical ReviewJob as
// GitHub and GitLab.
//
// PULL REQUEST EVENTS ONLY, and that is a decision rather than an omission.
// A chat command has to be authorized before it spends a customer's model
// budget, and Bitbucket's permission lookup for an arbitrary commenter needs
// workspace-admin scope a review bot has no business holding. So no Bitbucket
// comment ever becomes a job: `RestBitbucketClient.commandsAllowed` returns
// false and this file has no note handler. Automatic reviews work fully.
//
// Bitbucket signs its webhooks with HMAC-SHA256 in X-Hub-Signature (the same
// header name GitHub uses without the -256 suffix), so unlike GitLab there is a
// real signature to verify. It is verified with the shared helper, against its
// own secret.

// BitbucketEventHeader names the event, e.g. "pullrequest:created".
const BitbucketEventHeader = "X-Event-Key"

// BitbucketSignatureHeader carries the HMAC-SHA256 signature.
const BitbucketSignatureHeader = "X-Hub-Signature"

// bitbucketTriggerEvents are the pull request events worth a review.
//
// "pullrequest:updated" fires for a new push AND for a title or description
// edit, so the idempotency key (which binds to the head commit) is what stops an
// edited description from costing a second review.
var bitbucketTriggerEvents = map[string]bool{
	"pullrequest:created": true,
	"pullrequest:updated": true,
}

// bitbucketPullRequestEvent is the strict subset we consume. Same allow-list
// discipline as the other two normalizers: unlisted fields never reach the
// orchestrator.
type bitbucketPullRequestEvent struct {
	Repository struct {
		UUID      string `json:"uuid"`
		FullName  string `json:"full_name"`
		Workspace struct {
			Slug string `json:"slug"`
		} `json:"workspace"`
	} `json:"repository"`
	PullRequest struct {
		ID     int    `json:"id"`
		Title  string `json:"title"`
		State  string `json:"state"`
		Author struct {
			Nickname string `json:"nickname"`
		} `json:"author"`
		Source struct {
			Commit struct {
				Hash string `json:"hash"`
			} `json:"commit"`
		} `json:"source"`
		Destination struct {
			Commit struct {
				Hash string `json:"hash"`
			} `json:"commit"`
		} `json:"destination"`
	} `json:"pullrequest"`
}

// VerifyBitbucketSignature reports whether sig authenticates body under secret.
//
// Bitbucket sends "sha256=<hex>" in X-Hub-Signature, the same encoding GitHub
// uses, so this delegates to the same constant-time verifier. Fail-closed on an
// empty secret, for the same reason as everywhere else.
func VerifyBitbucketSignature(secret, sig string, body []byte) bool {
	return VerifySignature(secret, sig, body)
}

// NormalizeBitbucketPullRequest converts a pull request event into a job.
func NormalizeBitbucketPullRequest(body []byte, deliveryID, event string) (canonical.ReviewJob, error) {
	if !bitbucketTriggerEvents[event] {
		return canonical.ReviewJob{}, ErrNotTrigger
	}
	var ev bitbucketPullRequestEvent
	if err := json.Unmarshal(body, &ev); err != nil {
		return canonical.ReviewJob{}, fmt.Errorf("decode pullrequest payload: %w", err)
	}
	// A pull request that is merging or declining is not a review candidate even
	// when the event says "updated".
	if st := strings.ToUpper(ev.PullRequest.State); st == "MERGED" || st == "DECLINED" {
		return canonical.ReviewJob{}, ErrNotTrigger
	}
	if ev.PullRequest.ID == 0 || ev.Repository.FullName == "" || ev.PullRequest.Source.Commit.Hash == "" {
		return canonical.ReviewJob{}, errors.New("payload missing required fields (pr id / repo / head commit)")
	}

	full := ev.Repository.FullName
	job := canonical.ReviewJob{
		SchemaVersion: canonical.SchemaVersion,
		Platform:      canonical.PlatformBitbucket,
		DeliveryID:    deliveryID,
		Org:           namespaceOf(full),
		Repo:          full,
		// Bitbucket's repository id is a UUID, and RepoID is numeric. It is only
		// used inside the idempotency fingerprint, which already includes the
		// full name, so 0 costs nothing rather than mangling a UUID into an int.
		RepoID:   0,
		PRNumber: ev.PullRequest.ID,
		Action:   event,
		HeadSHA:  ev.PullRequest.Source.Commit.Hash,
		BaseSHA:  ev.PullRequest.Destination.Commit.Hash,
		Priority: canonical.DefaultPriority,
		Title:    ev.PullRequest.Title,
		Author:   ev.PullRequest.Author.Nickname,
		// No installation to mint a token from; credentials are per workspace.
		InstallationID: 0,
		EnqueuedAt:     time.Now().UTC().Format(time.RFC3339),
		Trigger:        canonical.TriggerPullRequest,
	}
	job.IdempotencyKey = bitbucketKey(job)
	return job, nil
}

// bitbucketKey fingerprints the logical unit of work. Unlike the GitHub key it
// folds in the repository FULL NAME rather than a numeric id, because Bitbucket
// repository ids are UUIDs and RepoID is 0 here.
func bitbucketKey(j canonical.ReviewJob) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s|%d|%s|%s", j.Repo, j.PRNumber, j.Action, j.HeadSHA)
	return fmt.Sprintf("%x", h.Sum(nil))
}
