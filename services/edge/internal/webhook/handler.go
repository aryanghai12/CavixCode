package webhook

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"time"

	"github.com/cavix/edge/internal/canonical"
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
	secret          string
	gitlabToken     string
	bitbucketSecret string
	queue           queue.Producer
	dedupe          dedupe.Store
	log             *slog.Logger
	botHandle       string          // comma-separated mention handles, e.g. "cavixcode,cavix"
	allowedCmd      map[string]bool // author_associations allowed to run commands
}

// NewHandler wires the edge handler. botHandle is the GitHub App's mention handle,
// or a comma-separated list of handles (empty → "cavixcode,cavix"); commands are
// honored only from allowed author associations.
func NewHandler(secret string, q queue.Producer, d dedupe.Store, log *slog.Logger, botHandle string) *Handler {
	if botHandle == "" {
		botHandle = "cavixcode,cavix"
	}
	return &Handler{secret: secret, queue: q, dedupe: d, log: log, botHandle: botHandle, allowedCmd: DefaultAllowedAssociations}
}

// WithGitLab enables GitLab ingestion on the SAME endpoint, authenticated by its
// own shared secret.
//
// One endpoint rather than two, because the two hosts are already distinguished
// unambiguously by their headers: GitHub sends X-GitHub-Event and GitLab sends
// X-Gitlab-Event, and a request carrying neither is rejected as it always was. A
// second listener would have meant a second URL for operators to configure, a
// second health check, and two places for the dedupe window to disagree.
//
// The secrets stay separate on purpose. They are configured on different systems
// by different people, and sharing one would mean a GitLab project hook could
// forge a GitHub delivery.
func (h *Handler) WithGitLab(token string) *Handler {
	h.gitlabToken = token
	return h
}

// WithBitbucket enables Bitbucket Cloud ingestion on the same endpoint, with its
// own secret, for the same reasons as WithGitLab: one URL for an operator to
// configure, and separate secrets so one host's hook cannot forge another's.
func (h *Handler) WithBitbucket(secret string) *Handler {
	h.bitbucketSecret = secret
	return h
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

	// 1b. GitLab and Bitbucket arrive on the same endpoint and are told apart by
	// their own headers, before anything GitHub-shaped is looked at.
	if gl := r.Header.Get(GitLabEventHeader); gl != "" {
		h.serveGitLab(w, r, start, gl, body)
		return
	}
	if bb := r.Header.Get(BitbucketEventHeader); bb != "" {
		h.serveBitbucket(w, r, start, bb, body)
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

	// 4. Route by event.
	switch event {
	case "pull_request":
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
		h.enqueue(w, r, start, delivery, job)

	case "issue_comment":
		// A human typed "@<handle> <command>" on a PR. Parse + authorize + enqueue.
		job, err := NormalizeIssueComment(body, delivery, h.botHandle)
		if err != nil {
			if errors.Is(err, ErrNotTrigger) {
				h.writeJSON(w, http.StatusAccepted, `{"status":"ignored","reason":"not_a_command"}`)
				return
			}
			h.log.Warn("issue_comment normalize failed", "delivery", delivery, "err", err.Error())
			http.Error(w, "unprocessable payload", http.StatusBadRequest)
			return
		}
		if !IsAuthorized(job.AuthorAssociation, h.allowedCmd) {
			h.log.Warn("unauthorized command", "delivery", delivery, "repo", job.Repo, "pr", job.PRNumber,
				"author", job.Author, "assoc", job.AuthorAssociation, "command", job.Command)
			h.writeJSON(w, http.StatusAccepted, `{"status":"ignored","reason":"unauthorized"}`)
			return
		}
		h.log.Info("command received", "delivery", delivery, "repo", job.Repo, "pr", job.PRNumber,
			"command", job.Command, "author", job.Author)
		h.enqueue(w, r, start, delivery, job)

	default:
		h.writeJSON(w, http.StatusAccepted, `{"status":"ignored","reason":"unsupported_event"}`)
	}
}

// serveGitLab handles a Merge Request or Note hook. Same shape as the GitHub
// path: authenticate first, normalize into the canonical job, dedupe, enqueue.
//
// Note the ONE deliberate difference in authorization. GitHub tells us the
// commenter's association with the repository, so the edge can refuse a command
// from a passer-by before any work is queued. GitLab sends no such field, so
// there is nothing here to check and the job is marked GITLAB_UNVERIFIED and
// enqueued for the orchestrator to authorize against the API. Guessing here
// would mean either turning away legitimate maintainers or letting anyone on the
// internet spend a customer's model budget, and neither is a guess worth making.
func (h *Handler) serveGitLab(w http.ResponseWriter, r *http.Request, start time.Time, event string, body []byte) {
	if h.gitlabToken == "" {
		h.log.Warn("gitlab webhook received but no gitlab secret is configured", "event", event)
		http.Error(w, "gitlab ingestion is not enabled", http.StatusUnauthorized)
		return
	}
	if !VerifyGitLabToken(h.gitlabToken, r.Header.Get(GitLabTokenHeader)) {
		h.log.Warn("gitlab token verification failed", "event", event)
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}

	// GitLab has no delivery id header, so the event UUID is used when present
	// and the idempotency key carries the weight either way.
	delivery := r.Header.Get("X-Gitlab-Event-UUID")

	var job canonical.ReviewJob
	var err error
	switch event {
	case "Merge Request Hook":
		job, err = NormalizeGitLabMergeRequest(body, delivery)
	case "Note Hook":
		job, err = NormalizeGitLabNote(body, delivery, h.botHandle)
	default:
		h.writeJSON(w, http.StatusAccepted, `{"status":"ignored","reason":"unsupported_event"}`)
		return
	}
	if err != nil {
		if errors.Is(err, ErrNotTrigger) {
			h.writeJSON(w, http.StatusAccepted, `{"status":"ignored","reason":"non_trigger_action"}`)
			return
		}
		h.log.Warn("gitlab normalize failed", "event", event, "err", err.Error())
		http.Error(w, "unprocessable payload", http.StatusBadRequest)
		return
	}
	h.enqueue(w, r, start, delivery, job)
}

// serveBitbucket handles a pull request event. Comments are deliberately NOT
// handled: see the note at the top of bitbucket.go. A command whose author's
// permission cannot be checked is an open door, and Bitbucket does not let a
// review bot check an arbitrary commenter's without workspace-admin scope.
func (h *Handler) serveBitbucket(w http.ResponseWriter, r *http.Request, start time.Time, event string, body []byte) {
	if h.bitbucketSecret == "" {
		h.log.Warn("bitbucket webhook received but no bitbucket secret is configured", "event", event)
		http.Error(w, "bitbucket ingestion is not enabled", http.StatusUnauthorized)
		return
	}
	if !VerifyBitbucketSignature(h.bitbucketSecret, r.Header.Get(BitbucketSignatureHeader), body) {
		h.log.Warn("bitbucket signature verification failed", "event", event)
		http.Error(w, "invalid signature", http.StatusUnauthorized)
		return
	}

	delivery := r.Header.Get("X-Request-UUID")
	job, err := NormalizeBitbucketPullRequest(body, delivery, event)
	if err != nil {
		if errors.Is(err, ErrNotTrigger) {
			h.writeJSON(w, http.StatusAccepted, `{"status":"ignored","reason":"non_trigger_action"}`)
			return
		}
		h.log.Warn("bitbucket normalize failed", "event", event, "err", err.Error())
		http.Error(w, "unprocessable payload", http.StatusBadRequest)
		return
	}
	h.enqueue(w, r, start, delivery, job)
}

// enqueue dedupes, persists, and acks a job (steps 6–7). Command jobs carry a
// per-comment idempotency key, so they are never deduped — each invocation runs.
func (h *Handler) enqueue(w http.ResponseWriter, r *http.Request, start time.Time, delivery string, job canonical.ReviewJob) {
	if h.dedupe.SeenBefore(job.IdempotencyKey) {
		h.log.Info("duplicate dropped", "delivery", delivery, "repo", job.Repo, "pr", job.PRNumber, "action", job.Action)
		h.writeJSON(w, http.StatusAccepted, `{"status":"duplicate"}`)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), enqueueTimeout)
	defer cancel()
	msgID, err := h.queue.Enqueue(ctx, job)
	if err != nil {
		h.log.Error("enqueue failed", "delivery", delivery, "repo", job.Repo, "pr", job.PRNumber, "err", err.Error())
		http.Error(w, "enqueue failed", http.StatusInternalServerError)
		return
	}

	tookMs := time.Since(start).Milliseconds()
	h.log.Info("job enqueued",
		"delivery", delivery, "msg_id", msgID, "repo", job.Repo, "pr", job.PRNumber,
		"trigger", job.Trigger, "action", job.Action, "command", job.Command,
		"idempotency", job.IdempotencyKey, "ack_ms", tookMs)
	h.writeJSON(w, http.StatusAccepted, `{"status":"queued"}`)
}

func (h *Handler) writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}
