package webhook

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cavix/edge/internal/canonical"
	"github.com/cavix/edge/internal/dedupe"
	"github.com/cavix/edge/internal/queue"
)

const bbBody = `{
  "repository": {"uuid": "{abc}", "full_name": "acme/widget", "workspace": {"slug": "acme"}},
  "pullrequest": {
    "id": 7, "title": "Add y", "state": "OPEN",
    "author": {"nickname": "octo"},
    "source": {"commit": {"hash": "head1"}},
    "destination": {"commit": {"hash": "base1"}}
  }
}`

func TestNormalizeBitbucketPullRequest(t *testing.T) {
	job, err := NormalizeBitbucketPullRequest([]byte(bbBody), "uuid-1", "pullrequest:created")
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if job.Platform != canonical.PlatformBitbucket {
		t.Fatalf("platform = %q", job.Platform)
	}
	if job.Org != "acme" || job.Repo != "acme/widget" {
		t.Fatalf("org/repo = %q/%q", job.Org, job.Repo)
	}
	if job.PRNumber != 7 || job.HeadSHA != "head1" {
		t.Fatalf("pr/sha = %d/%s", job.PRNumber, job.HeadSHA)
	}
	if job.Trigger != canonical.TriggerPullRequest {
		t.Fatalf("trigger = %q", job.Trigger)
	}
	// Bitbucket repository ids are UUIDs and RepoID is numeric, so the
	// idempotency key folds in the full name instead of mangling one into an int.
	if job.IdempotencyKey == "" {
		t.Fatal("every job needs an idempotency key")
	}
}

func TestBitbucketNonTriggerEventsAreIgnored(t *testing.T) {
	for _, event := range []string{"pullrequest:approved", "pullrequest:fulfilled", "repo:push", "pullrequest:comment_created"} {
		if _, err := NormalizeBitbucketPullRequest([]byte(bbBody), "d", event); err == nil {
			t.Fatalf("%s should be ignored", event)
		}
	}
}

func TestBitbucketMergedPullRequestIsNotReviewed(t *testing.T) {
	body := strings.Replace(bbBody, `"state": "OPEN"`, `"state": "MERGED"`, 1)
	if _, err := NormalizeBitbucketPullRequest([]byte(body), "d", "pullrequest:updated"); err == nil {
		t.Fatal("a merged pull request is not a review candidate")
	}
}

func TestBitbucketDeliveryNeedsAValidSignature(t *testing.T) {
	q := queue.NewFakeProducer()
	h := NewHandler("gh-secret", q, dedupe.NewMemoryStore(time.Hour), glLogger(), "cavixcode").WithBitbucket("bb-secret")

	// Wrong secret, and the GitHub secret, must both be refused.
	for _, secret := range []string{"wrong", "gh-secret"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(bbBody))
		req.Header.Set(BitbucketEventHeader, "pullrequest:created")
		req.Header.Set(BitbucketSignatureHeader, sign(secret, []byte(bbBody)))
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("secret %q: status = %d, want 401", secret, rec.Code)
		}
	}
	if q.Len() != 0 {
		t.Fatal("nothing may be enqueued from an unauthenticated delivery")
	}
}

func TestBitbucketDeliveryIsQueued(t *testing.T) {
	q := queue.NewFakeProducer()
	h := NewHandler("gh-secret", q, dedupe.NewMemoryStore(time.Hour), glLogger(), "cavixcode").WithBitbucket("bb-secret")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(bbBody))
	req.Header.Set(BitbucketEventHeader, "pullrequest:created")
	req.Header.Set(BitbucketSignatureHeader, sign("bb-secret", []byte(bbBody)))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if q.Len() != 1 || q.Jobs()[0].Platform != canonical.PlatformBitbucket {
		t.Fatalf("job = %+v", q.Jobs())
	}
}

func TestBitbucketIsRefusedWhenIngestionIsOff(t *testing.T) {
	q := queue.NewFakeProducer()
	h := NewHandler("gh-secret", q, dedupe.NewMemoryStore(time.Hour), glLogger(), "cavixcode")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(bbBody))
	req.Header.Set(BitbucketEventHeader, "pullrequest:created")
	req.Header.Set(BitbucketSignatureHeader, sign("gh-secret", []byte(bbBody)))
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestThreePlatformsCoexistOnOneEndpoint(t *testing.T) {
	// The seam, at the front door: each host is told apart by its own header and
	// authenticated with its own secret, so no host's hook can forge another's.
	q := queue.NewFakeProducer()
	h := NewHandler("gh-secret", q, dedupe.NewMemoryStore(time.Hour), glLogger(), "cavixcode").
		WithGitLab("gl-secret").
		WithBitbucket("bb-secret")

	gh := githubPullRequestBody()
	req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(gh))
	req.Header.Set("X-GitHub-Event", "pull_request")
	req.Header.Set("X-GitHub-Delivery", "d1")
	req.Header.Set(SignatureHeader, sign("gh-secret", []byte(gh)))
	h.ServeHTTP(httptest.NewRecorder(), req)

	req = httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(mrBody))
	req.Header.Set(GitLabEventHeader, "Merge Request Hook")
	req.Header.Set(GitLabTokenHeader, "gl-secret")
	h.ServeHTTP(httptest.NewRecorder(), req)

	req = httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(bbBody))
	req.Header.Set(BitbucketEventHeader, "pullrequest:created")
	req.Header.Set(BitbucketSignatureHeader, sign("bb-secret", []byte(bbBody)))
	h.ServeHTTP(httptest.NewRecorder(), req)

	if q.Len() != 3 {
		t.Fatalf("enqueued %d jobs, want 3", q.Len())
	}
	seen := map[string]bool{}
	for _, j := range q.Jobs() {
		seen[j.Platform] = true
	}
	for _, p := range []string{canonical.PlatformGitHub, canonical.PlatformGitLab, canonical.PlatformBitbucket} {
		if !seen[p] {
			t.Fatalf("missing platform %q", p)
		}
	}
}
