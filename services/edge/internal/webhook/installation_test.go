package webhook

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/cavix/edge/internal/queue"
)

type recordingSink struct {
	got []InstallationChange
	err error
}

func (s *recordingSink) Apply(_ context.Context, c InstallationChange) error {
	if s.err != nil {
		return s.err
	}
	s.got = append(s.got, c)
	return nil
}

func TestIsInstallationEvent(t *testing.T) {
	for _, e := range []string{"installation", "installation_repositories", "installation_target"} {
		if !IsInstallationEvent(e) {
			t.Fatalf("expected %q to be an installation event", e)
		}
	}
	for _, e := range []string{"pull_request", "issue_comment", "push", ""} {
		if IsInstallationEvent(e) {
			t.Fatalf("did not expect %q to be an installation event", e)
		}
	}
}

func TestNormalizeInstallationCreated(t *testing.T) {
	body := []byte(`{
	  "action": "created",
	  "installation": {
	    "id": 4242,
	    "account": {"id": 77, "login": "acme-inc", "type": "Organization"},
	    "repository_selection": "selected",
	    "html_url": "https://github.com/organizations/acme-inc/settings/installations/4242",
	    "updated_at": "2026-08-13T10:00:00Z"
	  },
	  "repositories": [{"id": 1, "full_name": "acme-inc/api", "private": true}]
	}`)

	c, err := NormalizeInstallation(body, "d1", "installation")
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if c.InstallationID != 4242 || c.AccountLogin != "acme-inc" || c.AccountType != "Organization" {
		t.Fatalf("wrong identity: %+v", c)
	}
	if c.RepositorySelection != "selected" {
		t.Fatalf("selection = %q", c.RepositorySelection)
	}
	if len(c.Repositories) != 1 || c.Repositories[0].ID != 1 {
		t.Fatalf("repositories not carried: %+v", c.Repositories)
	}
	if c.UpdatedAt != "2026-08-13T10:00:00Z" {
		t.Fatalf("updated_at = %q", c.UpdatedAt)
	}
}

// "all" is not a cosmetic difference. It means repositories created in future
// are automatically in scope, and a snapshot of today's repository list cannot
// express that.
func TestNormalizeInstallationRepositorySelectionAll(t *testing.T) {
	body := []byte(`{"action":"created","installation":{"id":1,"repository_selection":"all","account":{"login":"a"}}}`)
	c, err := NormalizeInstallation(body, "d", "installation")
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if c.RepositorySelection != "all" {
		t.Fatalf("selection = %q", c.RepositorySelection)
	}
}

// An absent selection reads as "selected": the narrowest claim, so a wrong guess
// under-reaches rather than reviewing a repository nobody granted.
func TestNormalizeInstallationDefaultsToSelected(t *testing.T) {
	body := []byte(`{"action":"created","installation":{"id":1,"account":{"login":"a"}}}`)
	c, err := NormalizeInstallation(body, "d", "installation")
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if c.RepositorySelection != "selected" {
		t.Fatalf("selection = %q", c.RepositorySelection)
	}
	if c.UpdatedAt == "" {
		t.Fatal("an unordered delivery is still ordered by arrival")
	}
}

// The repository picker's output. This is the control customers are told to use,
// and before this it had no effect until something else happened to refresh.
func TestNormalizeInstallationRepositoriesDelta(t *testing.T) {
	body := []byte(`{
	  "action": "added",
	  "installation": {"id": 9, "account": {"login": "acme"}, "repository_selection": "selected", "updated_at": "2026-08-13T11:00:00Z"},
	  "repositories_added": [{"id": 2, "full_name": "acme/web", "private": false}],
	  "repositories_removed": [{"id": 1, "full_name": "acme/api", "private": true}]
	}`)
	c, err := NormalizeInstallation(body, "d", "installation_repositories")
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if len(c.Added) != 1 || c.Added[0].ID != 2 {
		t.Fatalf("added: %+v", c.Added)
	}
	if len(c.Removed) != 1 || c.Removed[0].ID != 1 {
		t.Fatalf("removed: %+v", c.Removed)
	}
}

func TestNormalizeInstallationSuspended(t *testing.T) {
	body := []byte(`{"action":"suspend","installation":{"id":1,"account":{"login":"a"},"suspended_at":"2026-08-13T00:00:00Z"}}`)
	c, err := NormalizeInstallation(body, "d", "installation")
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if !c.Suspended {
		t.Fatal("a suspended installation must be reported as suspended, not as deleted")
	}
}

// A rename leaves every stored "owner/name" pointing at nothing. Carrying the
// previous login is what lets those be rewritten instead of silently breaking.
func TestNormalizeInstallationRename(t *testing.T) {
	body := []byte(`{"action":"renamed","installation":{"id":1,"account":{"login":"new-name"}},"changes":{"login":{"from":"old-name"}}}`)
	c, err := NormalizeInstallation(body, "d", "installation_target")
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if c.PreviousLogin != "old-name" || c.AccountLogin != "new-name" {
		t.Fatalf("rename not carried: %+v", c)
	}
}

func TestNormalizeInstallationIgnoresOtherActions(t *testing.T) {
	body := []byte(`{"action":"member_added","installation":{"id":1,"account":{"login":"a"}}}`)
	if _, err := NormalizeInstallation(body, "d", "installation"); !errors.Is(err, ErrNotInstallationEvent) {
		t.Fatalf("expected ErrNotInstallationEvent, got %v", err)
	}
}

func TestNormalizeInstallationRejectsMissingID(t *testing.T) {
	body := []byte(`{"action":"created","installation":{"account":{"login":"a"}}}`)
	if _, err := NormalizeInstallation(body, "d", "installation"); err == nil {
		t.Fatal("a payload with no installation id must not be accepted")
	}
}

func TestHandlerAppliesInstallationEvent(t *testing.T) {
	sink := &recordingSink{}
	h := newTestHandler(queue.NewFakeProducer()).WithInstallations(sink)

	body := []byte(`{"action":"created","installation":{"id":7,"account":{"id":1,"login":"acme","type":"Organization"},"repository_selection":"all","updated_at":"2026-08-13T10:00:00Z"}}`)
	rec := post(t, h, "installation", "d-install", string(body))

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if len(sink.got) != 1 || sink.got[0].InstallationID != 7 {
		t.Fatalf("sink did not receive the change: %+v", sink.got)
	}
	var out map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["status"] != "applied" {
		t.Fatalf("status field = %q", out["status"])
	}
}

// A deployment with no control-plane wired has nothing to tell, and that is a
// supported configuration. What is never acceptable is REJECTING the delivery:
// GitHub would retry forever an event Cavix has no intention of accepting.
func TestHandlerAcksInstallationWithNoSink(t *testing.T) {
	h := newTestHandler(queue.NewFakeProducer())
	body := []byte(`{"action":"created","installation":{"id":7,"account":{"login":"acme"}}}`)
	rec := post(t, h, "installation", "d-install", string(body))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d", rec.Code)
	}
}

// Same reasoning when the sink is down: log it, ACK it, and let reconciliation
// repair it. A 500 here turns one dropped update into an indefinite retry loop.
func TestHandlerAcksWhenSinkFails(t *testing.T) {
	h := newTestHandler(queue.NewFakeProducer()).WithInstallations(&recordingSink{err: errors.New("control-plane unreachable")})
	body := []byte(`{"action":"created","installation":{"id":7,"account":{"login":"acme"}}}`)
	rec := post(t, h, "installation", "d-install", string(body))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d", rec.Code)
	}
	var out map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["status"] != "deferred" {
		t.Fatalf("status field = %q", out["status"])
	}
}

func TestHandlerRejectsUnsignedInstallationEvent(t *testing.T) {
	sink := &recordingSink{}
	h := newTestHandler(queue.NewFakeProducer()).WithInstallations(sink)
	req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(`{"action":"created"}`))
	req.Header.Set("X-GitHub-Event", "installation")
	req.Header.Set(SignatureHeader, "sha256=deadbeef")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", rec.Code)
	}
	if len(sink.got) != 0 {
		t.Fatal("an unsigned delivery must never reach the sink")
	}
}
