package webhook

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/cavix/edge/internal/dedupe"
	"github.com/cavix/edge/internal/queue"
)

// maxBodyBytes caps the webhook body. GitHub payloads are well under this; the
// cap is a DoS guard so a hostile sender can't make us buffer unbounded memory.
const maxBodyBytes = 5 << 20 // 5 MiB

// enqueueTimeout bounds the enqueue round trip so the handler honors its <100ms
// ACK budget even if the broker is briefly slow.
const enqueueTimeout = 80 * time.Millisecond

// Handler implements the Stage 0 edge: verify → normalize → dedupe → enqueue →
// ACK fast. It depends only on ports (queue.Producer, dedupe.Store), so tests
// run with in-memory fakes and no infrastructure.
type Handler struct {
	secret string
	queue  queue.Producer
	dedupe dedupe.Store
	log    *slog.Logger
}

// NewHandler wires the edge handler.
func NewHandler(secret string, q queue.Producer, d dedupe.Store, log *slog.Logger) *Handler {
	return &Handler{secret: secret, queue: q, dedupe: d, log: log}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// 1. Read the raw body (capped) — we need the exact bytes for HMAC.
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	if err != nil {
		h.log.Warn("read body failed", "err", err.Error())
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}

	event := r.Header.Get("X-GitHub-Event")
	delivery := r.Header.Get("X-GitHub-Delivery")
	sig := r.Header.Get(SignatureHeader)

	// 2. Authenticate BEFORE trusting/parsing the body. Fail closed.
	if !VerifySignature(h.secret, sig, body) {
		// Do not echo the signature or secret. Log only the delivery id.
		h.log.Warn("signature verification failed", "delivery", delivery, "event", event)
		http.Error(w, "invalid signature", http.StatusUnauthorized)
		return
	}

	// 3. GitHub "ping" on app/webhook creation — acknowledge, no work.
	if event == "ping" {
		h.writeJSON(w, http.StatusOK, `{"status":"pong"}`)
		return
	}

	// 4. We only act on pull_request events; ACK everything else so GitHub
	//    doesn't retry, but produce no job.
	if event != "pull_request" {
		h.writeJSON(w, http.StatusAccepted, `{"status":"ignored","reason":"unsupported_event"}`)
		return
	}

	// 5. Normalize to the canonical ReviewJob.
	job, err := Normalize(body, delivery)
	if err != nil {
		if errors.Is(err, ErrNotTrigger) {
			h.writeJSON(w, http.StatusAccepted, `{"status":"ignored","reason":"non_trigger_action"}`)
			return
		}
		h.log.Warn("normalize failed", "delivery", delivery, "err", err.Error())
		http.Error(w, "unprocessable payload", http.StatusBadRequest)
		return
	}

	// 6. Idempotency: drop logical duplicates (redeliveries of the same commit).
	if h.dedupe.SeenBefore(job.IdempotencyKey) {
		h.log.Info("duplicate dropped",
			"delivery", delivery, "repo", job.Repo, "pr", job.PRNumber, "action", job.Action)
		h.writeJSON(w, http.StatusAccepted, `{"status":"duplicate"}`)
		return
	}

	// 7. Enqueue durably, THEN ack. If enqueue fails we return 5xx so GitHub
	//    retries — we never ack work we didn't persist.
	ctx, cancel := context.WithTimeout(r.Context(), enqueueTimeout)
	defer cancel()
	msgID, err := h.queue.Enqueue(ctx, job)
	if err != nil {
		h.log.Error("enqueue failed", "delivery", delivery, "repo", job.Repo, "pr", job.PRNumber, "err", err.Error())
		http.Error(w, "enqueue failed", http.StatusInternalServerError)
		return
	}

	tookMs := time.Since(start).Milliseconds()
	h.log.Info("review job enqueued",
		"delivery", delivery, "msg_id", msgID, "repo", job.Repo, "pr", job.PRNumber,
		"action", job.Action, "head_sha", job.HeadSHA, "idempotency", job.IdempotencyKey,
		"ack_ms", tookMs)

	h.writeJSON(w, http.StatusAccepted, `{"status":"queued"}`)
}

func (h *Handler) writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}
