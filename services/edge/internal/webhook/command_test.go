package webhook

import (
	"encoding/json"
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

// The GitHub App's slug is "cavixcode", so "@cavixcode review" is what humans
// actually type. Under a single "cavix" handle the trailing \b made that a
// non-match and the command was silently ignored.
func TestParseCommandMultipleHandles(t *testing.T) {
	const handles = "cavixcode,cavix"
	cases := []struct {
		body     string
		wantOK   bool
		wantName string
		wantArgs string
	}{
		{"@cavixcode review", true, "review", ""},
		{"@cavixcode", true, "help", ""},
		{"@CavixCode Review", true, "review", ""},
		{"@cavixcode[bot] review", true, "review", ""},
		{"@cavix review", true, "review", ""},
		{"please @cavixcode review this when you can", true, "review", "this when you can"},
		{"@cavixcode why is this unsafe?", true, "ask", "why is this unsafe?"},
		{"@cavixcodex review", false, "", ""}, // a different, unknown handle
		{"nothing to see here", false, "", ""},
	}
	for _, c := range cases {
		got, ok := ParseCommand(c.body, handles)
		if ok != c.wantOK {
			t.Fatalf("ParseCommand(%q) ok=%v want %v", c.body, ok, c.wantOK)
		}
		if ok && (got.Name != c.wantName || got.Args != c.wantArgs) {
			t.Fatalf("ParseCommand(%q) = %+v, want {%s %q}", c.body, got, c.wantName, c.wantArgs)
		}
	}
}

func TestSplitHandles(t *testing.T) {
	got := SplitHandles(" @cavix, cavixcode ")
	// Longest first, so "@cavixcode" is never matched as a bare "@cavix".
	if len(got) != 2 || got[0] != "cavixcode" || got[1] != "cavix" {
		t.Fatalf("SplitHandles = %v, want [cavixcode cavix]", got)
	}
	if len(SplitHandles("   ")) != 0 {
		t.Fatalf("empty setting must yield no handles")
	}
}

// Cavix quotes commands back in its own status comments; without this guard the
// bot would answer itself forever.
func TestIssueCommentFromBotIsIgnored(t *testing.T) {
	body := `{
		"action":"created",
		"issue":{"number":7,"title":"t","pull_request":{"url":"u"}},
		"comment":{"id":1,"body":"@cavixcode review","author_association":"OWNER",
		           "user":{"login":"cavixcode[bot]","type":"Bot"}},
		"repository":{"id":5,"full_name":"acme/widget","owner":{"login":"acme"}},
		"installation":{"id":9}
	}`
	if _, err := NormalizeIssueComment([]byte(body), "d-1", "cavixcode"); err != ErrNotTrigger {
		t.Fatalf("bot-authored command must be ignored, got err=%v", err)
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

// TestWireContract pins the JSON the orchestrator actually parses.
//
// The TypeScript side (services/orchestrator/test/wireContract.test.ts) asserts
// against these exact bytes. Nothing else couples the two languages: rename a
// json tag here and every job would still enqueue, then be dropped downstream as
// a "poison stream entry" with no user-visible error. If this test fails, update
// the TS fixture in the same commit.
func TestWireContract(t *testing.T) {
	body := `{
	  "action":"created",
	  "issue":{"number":7,"title":"Add login lookup","pull_request":{"url":"u"}},
	  "comment":{"id":998877,"body":"@cavixcode review","author_association":"OWNER",
	             "user":{"login":"aryan-ghai","type":"User"}},
	  "repository":{"id":55,"full_name":"aryan-ghai/my-repo","owner":{"login":"aryan-ghai"}},
	  "installation":{"id":9182}
	}`
	job, err := NormalizeIssueComment([]byte(body), "delivery-1", "cavixcode,cavix")
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	raw, err := json.Marshal(job)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// Exactly the keys the orchestrator reads, with the values it depends on.
	want := map[string]any{
		"schema_version":     "1",
		"trigger":            "command",
		"command":            "review",
		"comment_id":         float64(998877),
		"force_fresh":        true,
		"author_association": "OWNER",
		"installation_id":    float64(9182),
		"repo":               "aryan-ghai/my-repo",
		"pr_number":          float64(7),
		"head_sha":           "", // command jobs carry no commit
	}
	for k, w := range want {
		g, ok := got[k]
		if !ok {
			t.Fatalf("wire contract: key %q is missing; the orchestrator reads it", k)
		}
		if g != w {
			t.Fatalf("wire contract: %q = %v, want %v", k, g, w)
		}
	}
}
