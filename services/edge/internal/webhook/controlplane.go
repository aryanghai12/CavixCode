package webhook

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// ControlPlaneSink forwards installation lifecycle changes to the control-plane,
// which is the service that owns the installation record.
//
// The split is deliberate. The edge is the only service holding the GitHub App's
// webhook secret, so it is the only one that can authenticate a delivery; the
// control-plane is the only service holding the workspace and its repositories,
// so it is the only one that can act on it. Forwarding one small authenticated
// message between them beats giving either service the other's secrets.
type ControlPlaneSink struct {
	baseURL string
	token   string
	client  *http.Client
}

// NewControlPlaneSink builds a sink, or nil when it is not configured.
//
// Nil is a supported state, not a failure: a deployment with no control-plane
// (the offline demo, an edge-only test rig) has nothing to tell, and the handler
// acknowledges these deliveries and moves on rather than failing every one.
func NewControlPlaneSink(baseURL, token string, timeout time.Duration) *ControlPlaneSink {
	baseURL = strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if baseURL == "" || strings.TrimSpace(token) == "" {
		return nil
	}
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	return &ControlPlaneSink{baseURL: baseURL, token: token, client: &http.Client{Timeout: timeout}}
}

// Apply posts one change. Any non-2xx is an error so the handler logs it and
// ACKs anyway: a webhook endpoint that returns a failure makes GitHub retry, and
// retrying into a control-plane that is down turns one dropped update into a
// storm. The next reconciliation repairs it.
func (s *ControlPlaneSink) Apply(ctx context.Context, change InstallationChange) error {
	payload, err := json.Marshal(change)
	if err != nil {
		return fmt.Errorf("encode installation change: %w", err)
	}
	req, err := http.NewRequestWithContext(
		ctx, http.MethodPost, s.baseURL+"/api/internal/github/installation", bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("authorization", "Bearer "+s.token)

	res, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("control-plane returned %d", res.StatusCode)
	}
	return nil
}
