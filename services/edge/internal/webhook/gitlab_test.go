package webhook

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cavix/edge/internal/canonical"
	"github.com/cavix/edge/internal/dedupe"
	"github.com/cavix/edge/internal/queue"
)

const mrBody = `{
  "object_kind": "merge_request",
  "user": {"username": "octo"},
  "project": {"id": 77, "path_with_namespace": "acme/platform/billing"},
  "object_attributes": {
    "iid": 12, "title": "Add refund path", "action": "open", "state": "opened",
    "target_branch": "main", "last_commit": {"id": "deadbeef"}
  }
}`

const noteBody = `{
  "object_kind": "note",
  "user": {"username": "octo"},
  "project": {"id": 77, "path_with_namespace": "acme/platform/billing"},
  "object_attributes": {"id": 991, "note": "@cavixcode review", "noteable_type": "MergeRequest"},
  "merge_request": {"iid": 12, "title": "Add refund path", "state": "opened", "last_commit": {"id": "deadbeef"}}
}`

func TestVerifyGitLabTokenIsFailClosed(t *testing.T) {
	if VerifyGitLabToken("", "anything") {
		t.Fatal("no configured secret must never verify")
	}
	if VerifyGitLabToken("s3cret", "") {
		t.Fatal("an absent token must never verify")
	}
	if VerifyGitLabToken("s3cret", "wrong") {
		t.Fatal("a wrong token must not verify")
	}
	if !VerifyGitLabToken("s3cret", "s3cret") {
		t.Fatal("the right token must verify")
	}
}

func TestNormalizeGitLabMergeRequest(t *testing.T) {
	job, err := NormalizeGitLabMergeRequest([]byte(mrBody), "uuid-1")
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if job.Platform != canonical.PlatformGitLab {
		t.Fatalf("platform = %q, want gitlab", job.Platform)
	}
	// A nested group keeps its whole namespace. Taking the first segment would
	// file every review in a subgroup under the wrong workspace.
	if job.Org != "acme/platform" {
		t.Fatalf("org = %q, want acme/platform", job.Org)
	}
	if job.Repo != "acme/platform/billing" {
		t.Fatalf("repo = %q", job.Repo)
	}
	if job.PRNumber != 12 || job.HeadSHA != "deadbeef" {
		t.Fatalf("iid/sha = %d/%s", job.PRNumber, job.HeadSHA)
	}
	if job.InstallationID != 0 {
		t.Fatal("gitlab has no installation to mint a token from")
	}
	if job.Trigger != canonical.TriggerPullRequest {
		t.Fatalf("trigger = %q", job.Trigger)
	}
	if job.IdempotencyKey == "" {
		t.Fatal("every job needs an idempotency key")
	}
}

func TestGitLabNonTriggerActionsAreIgnored(t *testing.T) {
	for _, tc := range []struct{ name, patch string }{
		{"close", `"action": "close"`},
		{"approved", `"action": "approved"`},
		{"merged state", `"action": "update", "state": "merged"`},
	} {
		body := strings.Replace(mrBody, `"action": "open", "state": "opened"`, tc.patch, 1)
		if _, err := NormalizeGitLabMergeRequest([]byte(body), "d"); err == nil {
			t.Fatalf("%s: expected the event to be ignored", tc.name)
		}
	}
}

func TestNormalizeGitLabNoteUsesTheSameCommandParser(t *testing.T) {
	job, err := NormalizeGitLabNote([]byte(noteBody), "uuid-2", "cavixcode,cavix")
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if job.Trigger != canonical.TriggerCommand || job.Command != "review" {
		t.Fatalf("trigger/command = %q/%q", job.Trigger, job.Command)
	}
	if job.CommentID != 991 {
		t.Fatalf("comment id = %d", job.CommentID)
	}
	if !job.ForceFresh {
		t.Fatal("an explicit review command discards the previous one")
	}
	// The edge cannot establish a GitLab commenter's permission, so it says so
	// rather than guessing. The marker is deliberately not an allowed
	// association, so the edge's own authorizer would refuse it.
	if job.AuthorAssociation != GitLabUnknownAssociation {
		t.Fatalf("association = %q", job.AuthorAssociation)
	}
	if IsAuthorized(job.AuthorAssociation, DefaultAllowedAssociations) {
		t.Fatal("an unverified association must never pass the edge's own check")
	}
}

func TestGitLabNoteOnSomethingOtherThanAnMRIsIgnored(t *testing.T) {
	body := strings.Replace(noteBody, `"noteable_type": "MergeRequest"`, `"noteable_type": "Issue"`, 1)
	if _, err := NormalizeGitLabNote([]byte(body), "d", "cavixcode"); err == nil {
		t.Fatal("a comment on an issue is not a review command")
	}
}

// ── the handler ─────────────────────────────────────────────────────────────

func TestGitLabDeliveryIsRejectedWithoutTheRightToken(t *testing.T) {
	h, q := gitlabHandler(t)
	for _, token := range []string{"", "wrong"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(mrBody))
		req.Header.Set(GitLabEventHeader, "Merge Request Hook")
		if token != "" {
			req.Header.Set(GitLabTokenHeader, token)
		}
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("token %q: status = %d, want 401", token, rec.Code)
		}
	}
	if q.Len() != 0 {
		t.Fatal("nothing may be enqueued from an unauthenticated delivery")
	}
}

func TestGitLabDeliveryIsQueued(t *testing.T) {
	h, q := gitlabHandler(t)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(mrBody))
	req.Header.Set(GitLabEventHeader, "Merge Request Hook")
	req.Header.Set(GitLabTokenHeader, "gl-secret")
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if q.Len() != 1 {
		t.Fatalf("enqueued %d jobs", q.Len())
	}
	if q.Jobs()[0].Platform != canonical.PlatformGitLab {
		t.Fatalf("platform = %q", q.Jobs()[0].Platform)
	}
}

func TestAGitHubDeliveryIsUnaffectedByGitLabBeingOn(t *testing.T) {
	// The one platform with real users must not notice that a second exists.
	h, q := gitlabHandler(t)
	body := githubPullRequestBody()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(body))
	req.Header.Set("X-GitHub-Event", "pull_request")
	req.Header.Set("X-GitHub-Delivery", "d-1")
	req.Header.Set(SignatureHeader, sign("gh-secret", []byte(body)))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if q.Len() != 1 || q.Jobs()[0].Platform != canonical.PlatformGitHub {
		t.Fatalf("github job did not survive: %+v", q.Jobs())
	}
}

func TestAGitLabDeliveryIsRefusedWhenIngestionIsOff(t *testing.T) {
	// A deployment that never configured GitLab must reject its deliveries, not
	// accept them on the GitHub secret.
	q := queue.NewFakeProducer()
	h := NewHandler("gh-secret", q, dedupe.NewMemoryStore(time.Hour), glLogger(), "cavixcode")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(mrBody))
	req.Header.Set(GitLabEventHeader, "Merge Request Hook")
	req.Header.Set(GitLabTokenHeader, "gh-secret")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func gitlabHandler(t *testing.T) (*Handler, *queue.FakeProducer) {
	t.Helper()
	q := queue.NewFakeProducer()
	return NewHandler("gh-secret", q, dedupe.NewMemoryStore(time.Hour), glLogger(), "cavixcode,cavix").WithGitLab("gl-secret"), q
}

func githubPullRequestBody() string {
	b, _ := json.Marshal(map[string]any{
		"action": "opened",
		"number": 7,
		"pull_request": map[string]any{
			"title": "t",
			"user":  map[string]any{"login": "octo"},
			"head":  map[string]any{"sha": "abc"},
			"base":  map[string]any{"sha": "def"},
		},
		"repository": map[string]any{
			"id": 1, "full_name": "acme/widget", "owner": map[string]any{"login": "acme"},
		},
		"installation": map[string]any{"id": 9},
	})
	return string(b)
}

func glLogger() *slog.Logger { return slog.New(slog.NewJSONHandler(io.Discard, nil)) }
