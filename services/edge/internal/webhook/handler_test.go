package webhook

import (
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cavix/edge/internal/dedupe"
	"github.com/cavix/edge/internal/queue"
)

const testSecret = "webhook-secret"

func newTestHandler(q queue.Producer) *Handler {
	log := slog.New(slog.NewJSONHandler(io.Discard, nil)) // silence logs in tests
	return NewHandler(testSecret, q, dedupe.NewMemoryStore(time.Hour), log, "cavix")
}

// post builds a signed request to /webhook with the given event + body.
func post(t *testing.T, h *Handler, event, delivery, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(body))
	req.Header.Set("X-GitHub-Event", event)
	req.Header.Set("X-GitHub-Delivery", delivery)
	req.Header.Set(SignatureHeader, sign(testSecret, []byte(body)))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestHandler_HappyPath(t *testing.T) {
	q := queue.NewFakeProducer()
	h := newTestHandler(q)

	start := time.Now()
	rec := post(t, h, "pull_request", "d1", prEvent("opened", "head123"))
	elapsed := time.Since(start)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want 202; body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"queued"`) {
		t.Fatalf("body = %s", rec.Body.String())
	}
	if q.Len() != 1 {
		t.Fatalf("expected 1 job enqueued, got %d", q.Len())
	}
	job := q.Jobs()[0]
	if job.Repo != "acme/widget" || job.PRNumber != 42 || job.HeadSHA != "head123" {
		t.Fatalf("enqueued job wrong: %+v", job)
	}
	// Acceptance: ACK well under 100ms (in-process fake → microseconds; assert
	// a generous bound that still proves we don't block on slow work).
	if elapsed > 100*time.Millisecond {
		t.Fatalf("ACK took %v, want <100ms", elapsed)
	}
}

func TestHandler_BadSignature(t *testing.T) {
	q := queue.NewFakeProducer()
	h := newTestHandler(q)

	body := prEvent("opened", "head123")
	req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(body))
	req.Header.Set("X-GitHub-Event", "pull_request")
	req.Header.Set(SignatureHeader, "sha256=deadbeef") // wrong
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if q.Len() != 0 {
		t.Fatal("must not enqueue on bad signature")
	}
}

func TestHandler_DuplicateDropped(t *testing.T) {
	q := queue.NewFakeProducer()
	h := newTestHandler(q)
	body := prEvent("synchronize", "headDUP")

	first := post(t, h, "pull_request", "d1", body)
	second := post(t, h, "pull_request", "d2", body) // redelivery, same commit

	if first.Code != http.StatusAccepted || !strings.Contains(first.Body.String(), "queued") {
		t.Fatalf("first should queue: %d %s", first.Code, first.Body.String())
	}
	if second.Code != http.StatusAccepted || !strings.Contains(second.Body.String(), "duplicate") {
		t.Fatalf("second should be duplicate: %d %s", second.Code, second.Body.String())
	}
	if q.Len() != 1 {
		t.Fatalf("expected exactly 1 job after duplicate, got %d", q.Len())
	}
}

func TestHandler_Ping(t *testing.T) {
	q := queue.NewFakeProducer()
	h := newTestHandler(q)
	rec := post(t, h, "ping", "d1", `{"zen":"hello"}`)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "pong") {
		t.Fatalf("ping: %d %s", rec.Code, rec.Body.String())
	}
	if q.Len() != 0 {
		t.Fatal("ping must not enqueue")
	}
}

func TestHandler_NonTriggerAction(t *testing.T) {
	q := queue.NewFakeProducer()
	h := newTestHandler(q)
	rec := post(t, h, "pull_request", "d1", prEvent("labeled", "head123"))
	if rec.Code != http.StatusAccepted || !strings.Contains(rec.Body.String(), "ignored") {
		t.Fatalf("labeled action: %d %s", rec.Code, rec.Body.String())
	}
	if q.Len() != 0 {
		t.Fatal("non-trigger action must not enqueue")
	}
}

func TestHandler_UnsupportedEvent(t *testing.T) {
	q := queue.NewFakeProducer()
	h := newTestHandler(q)
	rec := post(t, h, "issues", "d1", `{"action":"opened"}`)
	if rec.Code != http.StatusAccepted || !strings.Contains(rec.Body.String(), "ignored") {
		t.Fatalf("issues event: %d %s", rec.Code, rec.Body.String())
	}
	if q.Len() != 0 {
		t.Fatal("unsupported event must not enqueue")
	}
}

func TestHandler_EnqueueFailureReturns500(t *testing.T) {
	q := queue.NewFakeProducer()
	q.FailWith = errors.New("broker down")
	h := newTestHandler(q)
	rec := post(t, h, "pull_request", "d1", prEvent("opened", "head123"))
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 so GitHub retries", rec.Code)
	}
}

func TestHandler_MethodNotAllowed(t *testing.T) {
	h := newTestHandler(queue.NewFakeProducer())
	req := httptest.NewRequest(http.MethodGet, "/webhook", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET should be 405, got %d", rec.Code)
	}
}
