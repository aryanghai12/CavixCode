package webhook

import (
	"errors"
	"testing"
)

// prEvent builds a minimal valid pull_request payload for tests.
func prEvent(action, headSHA string) string {
	return `{
      "action": "` + action + `",
      "number": 42,
      "pull_request": {
        "title": "Add caching layer",
        "user": {"login": "octocat"},
        "head": {"sha": "` + headSHA + `"},
        "base": {"sha": "base000"}
      },
      "repository": {
        "id": 1234,
        "full_name": "acme/widget",
        "owner": {"login": "acme"}
      },
      "installation": {"id": 99}
    }`
}

func TestNormalize_Valid(t *testing.T) {
	job, err := Normalize([]byte(prEvent("opened", "head123")), "delivery-abc")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if job.Repo != "acme/widget" || job.Org != "acme" || job.RepoID != 1234 {
		t.Fatalf("repo fields wrong: %+v", job)
	}
	if job.PRNumber != 42 || job.HeadSHA != "head123" || job.BaseSHA != "base000" {
		t.Fatalf("pr fields wrong: %+v", job)
	}
	if job.Action != "opened" || job.Author != "octocat" || job.InstallationID != 99 {
		t.Fatalf("meta fields wrong: %+v", job)
	}
	if job.DeliveryID != "delivery-abc" {
		t.Fatalf("delivery id = %q", job.DeliveryID)
	}
	if job.SchemaVersion != "1" || job.Priority != 100 {
		t.Fatalf("schema/priority wrong: %+v", job)
	}
	if job.IdempotencyKey == "" {
		t.Fatal("idempotency key not set")
	}
	if job.EnqueuedAt == "" {
		t.Fatal("EnqueuedAt not set")
	}
}

func TestNormalize_NonTriggerAction(t *testing.T) {
	_, err := Normalize([]byte(prEvent("labeled", "head123")), "d")
	if !errors.Is(err, ErrNotTrigger) {
		t.Fatalf("expected ErrNotTrigger, got %v", err)
	}
}

func TestNormalize_MissingFields(t *testing.T) {
	// Trigger action but no head sha / repo id → reject as malformed.
	body := `{"action":"opened","number":0,"pull_request":{"head":{"sha":""}},"repository":{"id":0}}`
	_, err := Normalize([]byte(body), "d")
	if err == nil || errors.Is(err, ErrNotTrigger) {
		t.Fatalf("expected malformed error, got %v", err)
	}
}

func TestNormalize_GarbageJSON(t *testing.T) {
	_, err := Normalize([]byte(`{not json`), "d")
	if err == nil {
		t.Fatal("expected decode error")
	}
}

func TestIdempotencyKey_StableAndDistinct(t *testing.T) {
	a, _ := Normalize([]byte(prEvent("synchronize", "headAAA")), "d1")
	b, _ := Normalize([]byte(prEvent("synchronize", "headAAA")), "d2") // redelivery, same commit
	c, _ := Normalize([]byte(prEvent("synchronize", "headBBB")), "d3") // new commit

	if a.IdempotencyKey != b.IdempotencyKey {
		t.Fatal("same logical event must share an idempotency key (dedupe redeliveries)")
	}
	if a.IdempotencyKey == c.IdempotencyKey {
		t.Fatal("a new head commit must produce a distinct idempotency key")
	}
}
