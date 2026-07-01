package webhook

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cavix/edge/internal/canonical"
	"github.com/cavix/edge/internal/queue"
)

func TestParseCommand(t *testing.T) {
	cases := []struct {
		body     string
		wantOK   bool
		wantName string
		wantArgs string
	}{
		{"@cavix review", true, "review", ""},
		{"hey @cavix review please", true, "review", "please"},
		{"@Cavix RESOLVE", true, "resolve", ""},
		{"@cavix re-review", true, "review", ""},
		{"@cavix pause", true, "pause", ""},
		{"@cavix", true, "help", ""},
		{"@cavix why is this a bug?", true, "ask", "why is this a bug?"},
		{"@cavix ask what does this function do", true, "ask", "what does this function do"},
		{"looks good to me", false, "", ""},
		{"email me @ cavix dot com", false, "", ""},
	}
	for _, c := range cases {
		got, ok := ParseCommand(c.body, "cavix")
		if ok != c.wantOK {
			t.Fatalf("ParseCommand(%q) ok=%v want %v", c.body, ok, c.wantOK)
		}
		if ok && (got.Name != c.wantName || got.Args != c.wantArgs) {
			t.Fatalf("ParseCommand(%q) = %+v, want {%s %q}", c.body, got, c.wantName, c.wantArgs)
		}
	}
}

func issueComment(assoc, bodyText string) string {
	return `{
      "action": "created",
      "issue": { "number": 42, "title": "Add login", "pull_request": { "url": "https://api.github.com/pr/42" } },
      "comment": { "id": 555, "body": "` + bodyText + `", "author_association": "` + assoc + `", "user": { "login": "alice" } },
      "repository": { "id": 1234, "full_name": "acme/widget", "owner": { "login": "acme" } },
      "installation": { "id": 99 }
    }`
}

func TestNormalizeIssueComment_ReviewCommand(t *testing.T) {
	job, err := NormalizeIssueComment([]byte(issueComment("MEMBER", "@cavix review")), "d1", "cavix")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if job.Trigger != canonical.TriggerCommand || job.Command != "review" {
		t.Fatalf("trigger/command wrong: %+v", job)
	}
	if !job.ForceFresh {
		t.Fatal("review command must force a fresh review")
	}
	if job.PRNumber != 42 || job.Repo != "acme/widget" || job.CommentID != 555 {
		t.Fatalf("fields wrong: %+v", job)
	}
	if job.AuthorAssociation != "MEMBER" {
		t.Fatalf("assoc = %q", job.AuthorAssociation)
	}
}

func TestNormalizeIssueComment_UniqueKeyPerComment(t *testing.T) {
	// Two review commands (different comment ids) must NOT collide → always fresh.
	a, _ := NormalizeIssueComment([]byte(issueComment("MEMBER", "@cavix review")), "d1", "cavix")
	b := issueComment("MEMBER", "@cavix review")
	b = strings.Replace(b, `"id": 555`, `"id": 556`, 1)
	jb, _ := NormalizeIssueComment([]byte(b), "d2", "cavix")
	if a.IdempotencyKey == jb.IdempotencyKey {
		t.Fatal("distinct command invocations must have distinct idempotency keys")
	}
}

func TestNormalizeIssueComment_IgnoresNonCommands(t *testing.T) {
	if _, err := NormalizeIssueComment([]byte(issueComment("MEMBER", "nice work")), "d", "cavix"); err != ErrNotTrigger {
		t.Fatalf("plain comment should be ErrNotTrigger, got %v", err)
	}
	// A comment on a plain issue (no pull_request) is ignored.
	noPR := `{"action":"created","issue":{"number":5,"title":"bug"},"comment":{"id":1,"body":"@cavix review","author_association":"OWNER"},"repository":{"id":1,"full_name":"a/b"}}`
	if _, err := NormalizeIssueComment([]byte(noPR), "d", "cavix"); err != ErrNotTrigger {
		t.Fatalf("issue (non-PR) comment should be ErrNotTrigger, got %v", err)
	}
}

func TestHandler_Command_Authorized(t *testing.T) {
	q := queue.NewFakeProducer()
	h := newTestHandler(q)
	rec := postEvent(t, h, "issue_comment", "d1", issueComment("MEMBER", "@cavix review"))
	if rec.Code != http.StatusAccepted || !strings.Contains(rec.Body.String(), "queued") {
		t.Fatalf("authorized command should queue: %d %s", rec.Code, rec.Body.String())
	}
	if q.Len() != 1 {
		t.Fatalf("expected 1 command job, got %d", q.Len())
	}
	if q.Jobs()[0].Command != "review" {
		t.Fatalf("command not set: %+v", q.Jobs()[0])
	}
}

func TestHandler_Command_Unauthorized(t *testing.T) {
	q := queue.NewFakeProducer()
	h := newTestHandler(q)
	// A random outside contributor may not trigger reviews.
	rec := postEvent(t, h, "issue_comment", "d1", issueComment("NONE", "@cavix review"))
	if rec.Code != http.StatusAccepted || !strings.Contains(rec.Body.String(), "unauthorized") {
		t.Fatalf("unauthorized command should be ignored: %d %s", rec.Code, rec.Body.String())
	}
	if q.Len() != 0 {
		t.Fatal("unauthorized command must not enqueue")
	}
}

func TestHandler_Command_NotACommand(t *testing.T) {
	q := queue.NewFakeProducer()
	h := newTestHandler(q)
	rec := postEvent(t, h, "issue_comment", "d1", issueComment("MEMBER", "lgtm"))
	if rec.Code != http.StatusAccepted || !strings.Contains(rec.Body.String(), "not_a_command") {
		t.Fatalf("non-command comment ignored: %d %s", rec.Code, rec.Body.String())
	}
	if q.Len() != 0 {
		t.Fatal("non-command comment must not enqueue")
	}
}

// postEvent signs and posts an arbitrary event to the handler.
func postEvent(t *testing.T, h *Handler, event, delivery, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(body))
	req.Header.Set("X-GitHub-Event", event)
	req.Header.Set("X-GitHub-Delivery", delivery)
	req.Header.Set(SignatureHeader, sign(testSecret, []byte(body)))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}
