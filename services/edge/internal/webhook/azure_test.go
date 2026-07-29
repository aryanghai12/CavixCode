package webhook

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/cavix/edge/internal/canonical"
	"github.com/cavix/edge/internal/dedupe"
	"github.com/cavix/edge/internal/queue"
)

const azBody = `{
  "eventType": "git.pullrequest.updated",
  "resource": {
    "pullRequestId": 42,
    "title": "Add retries to the billing client",
    "status": "active",
    "isDraft": false,
    "sourceRefName": "refs/heads/feature/retries",
    "targetRefName": "refs/heads/main",
    "lastMergeSourceCommit": {"commitId": "aaaa1111"},
    "lastMergeTargetCommit": {"commitId": "bbbb2222"},
    "createdBy": {"uniqueName": "dev@acme.com", "displayName": "A Dev"},
    "repository": {"name": "billing-api", "project": {"name": "payments"}}
  },
  "resourceContainers": {"account": {"baseUrl": "https://dev.azure.com/acme/"}}
}`

func azureBasic(user, pass string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
}

func TestNormalizeAzurePullRequest(t *testing.T) {
	job, err := NormalizeAzurePullRequest([]byte(azBody), "req-1")
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if job.Platform != canonical.PlatformAzureDevOps {
		t.Fatalf("platform = %q", job.Platform)
	}
	// "organization/project/repository". The orchestrator splits at the LAST
	// slash, so owner is "acme/payments" and repo is "billing-api", which is the
	// shape every Azure REST path wants.
	if job.Repo != "acme/payments/billing-api" {
		t.Fatalf("repo = %q", job.Repo)
	}
	if job.Org != "acme" {
		t.Fatalf("org = %q", job.Org)
	}
	if job.PRNumber != 42 || job.HeadSHA != "aaaa1111" || job.BaseSHA != "bbbb2222" {
		t.Fatalf("pr/head/base = %d/%s/%s", job.PRNumber, job.HeadSHA, job.BaseSHA)
	}
	if job.Trigger != canonical.TriggerPullRequest {
		t.Fatalf("trigger = %q", job.Trigger)
	}
	if job.Author != "dev@acme.com" {
		t.Fatalf("author = %q", job.Author)
	}
	if job.IdempotencyKey == "" {
		t.Fatal("every job needs an idempotency key")
	}
}

func TestAzureOrgIsReadFromEveryHostShape(t *testing.T) {
	// All three appear in the wild, and the organisation NAME (not the GUID the
	// payload also carries) is what every REST path is built from.
	cases := map[string]string{
		"https://dev.azure.com/acme/":                  "acme",
		"https://dev.azure.com/acme":                   "acme",
		"https://acme.visualstudio.com/":               "acme",
		"https://tfs.acme.local/tfs/DefaultCollection": "DefaultCollection",
		"": "",
	}
	for in, want := range cases {
		if got := azureOrgFromBaseURL(in); got != want {
			t.Fatalf("azureOrgFromBaseURL(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestAzureNonTriggerEventsAreIgnored(t *testing.T) {
	for _, event := range []string{
		"git.pullrequest.merged",
		"git.push",
		"ms.vss-code.git-pullrequest-comment-event",
	} {
		body := strings.Replace(azBody, `"eventType": "git.pullrequest.updated"`, `"eventType": "`+event+`"`, 1)
		if _, err := NormalizeAzurePullRequest([]byte(body), "d"); err == nil {
			t.Fatalf("%s should be ignored", event)
		}
	}
}

func TestAzureCompletedPullRequestIsNotReviewed(t *testing.T) {
	for _, status := range []string{"completed", "abandoned"} {
		body := strings.Replace(azBody, `"status": "active"`, `"status": "`+status+`"`, 1)
		if _, err := NormalizeAzurePullRequest([]byte(body), "d"); err == nil {
			t.Fatalf("a %s pull request is not a review candidate", status)
		}
	}
}

func TestAzurePayloadMissingFieldsIsRejected(t *testing.T) {
	// A payload with no repository, or no head commit, must not become a job that
	// the orchestrator then fails on halfway through a review.
	for _, broken := range []string{
		strings.Replace(azBody, `"name": "billing-api"`, `"name": ""`, 1),
		strings.Replace(azBody, `"commitId": "aaaa1111"`, `"commitId": ""`, 1),
		strings.Replace(azBody, `"baseUrl": "https://dev.azure.com/acme/"`, `"baseUrl": ""`, 1),
		strings.Replace(azBody, `"project": {"name": "payments"}`, `"project": {"name": ""}`, 1),
	} {
		if _, err := NormalizeAzurePullRequest([]byte(broken), "d"); err == nil {
			t.Fatal("an incomplete payload must be refused at the edge")
		}
	}
}

func TestVerifyAzureBasic(t *testing.T) {
	if !VerifyAzureBasic("s3cret", azureBasic("cavix", "s3cret")) {
		t.Fatal("the configured credential must be accepted")
	}
	// The username half is the operator's choice and is not part of the secret.
	if !VerifyAzureBasic("s3cret", azureBasic("anything", "s3cret")) {
		t.Fatal("only the password half is the secret")
	}
	for _, bad := range []string{
		"",
		"Basic",
		"Bearer s3cret",
		azureBasic("cavix", "wrong"),
		azureBasic("cavix", ""),
		"Basic not-base64!!",
		// No colon at all: not a Basic credential.
		"Basic " + base64.StdEncoding.EncodeToString([]byte("s3cret")),
	} {
		if VerifyAzureBasic("s3cret", bad) {
			t.Fatalf("must refuse %q", bad)
		}
	}
	// Fail closed: with no secret configured, nothing authenticates.
	if VerifyAzureBasic("", azureBasic("cavix", "")) {
		t.Fatal("an empty secret must accept nothing")
	}
}

func TestAzureDeliveryNeedsValidCredentials(t *testing.T) {
	q := queue.NewFakeProducer()
	h := NewHandler("gh-secret", q, dedupe.NewMemoryStore(time.Hour), glLogger(), "cavixcode").WithAzure("az-secret")

	for _, auth := range []string{"", azureBasic("cavix", "wrong"), azureBasic("cavix", "gh-secret")} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(azBody))
		req.Header.Set(AzurePlatformHeader, AzurePlatformValue)
		if auth != "" {
			req.Header.Set("Authorization", auth)
		}
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("auth %q: status = %d, want 401", auth, rec.Code)
		}
	}
	if q.Len() != 0 {
		t.Fatal("nothing may be enqueued from an unauthenticated delivery")
	}
}

func TestAzureDeliveryIsQueued(t *testing.T) {
	q := queue.NewFakeProducer()
	h := NewHandler("gh-secret", q, dedupe.NewMemoryStore(time.Hour), glLogger(), "cavixcode").WithAzure("az-secret")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(azBody))
	req.Header.Set(AzurePlatformHeader, AzurePlatformValue)
	req.Header.Set("Authorization", azureBasic("cavix", "az-secret"))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if q.Len() != 1 || q.Jobs()[0].Platform != canonical.PlatformAzureDevOps {
		t.Fatalf("job = %+v", q.Jobs())
	}
}

func TestAzureIsRecognisedWithoutTheOptionalHeader(t *testing.T) {
	// Azure service hooks send no event header of their own, so a subscription
	// configured with nothing but the Basic credential has to work.
	q := queue.NewFakeProducer()
	h := NewHandler("gh-secret", q, dedupe.NewMemoryStore(time.Hour), glLogger(), "cavixcode").WithAzure("az-secret")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(azBody))
	req.Header.Set("Authorization", azureBasic("cavix", "az-secret"))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if q.Len() != 1 {
		t.Fatalf("enqueued %d, want 1", q.Len())
	}
}

func TestAzureRoutingNeverIntercceptsAGitHubDelivery(t *testing.T) {
	// The routing rule falls back to Azure when no other host's header is
	// present. A GitHub delivery always carries X-GitHub-Event, so it must still
	// reach the GitHub path even with Azure enabled.
	q := queue.NewFakeProducer()
	h := NewHandler("gh-secret", q, dedupe.NewMemoryStore(time.Hour), glLogger(), "cavixcode").WithAzure("az-secret")

	gh := githubPullRequestBody()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(gh))
	req.Header.Set("X-GitHub-Event", "pull_request")
	req.Header.Set("X-GitHub-Delivery", "d1")
	req.Header.Set(SignatureHeader, sign("gh-secret", []byte(gh)))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if q.Len() != 1 || q.Jobs()[0].Platform != canonical.PlatformGitHub {
		t.Fatalf("job = %+v", q.Jobs())
	}
}

func TestAzureIsRefusedWhenIngestionIsOff(t *testing.T) {
	q := queue.NewFakeProducer()
	h := NewHandler("gh-secret", q, dedupe.NewMemoryStore(time.Hour), glLogger(), "cavixcode")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(azBody))
	req.Header.Set(AzurePlatformHeader, AzurePlatformValue)
	req.Header.Set("Authorization", azureBasic("cavix", "az-secret"))
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
	if q.Len() != 0 {
		t.Fatal("a deployment that has not configured Azure enqueues nothing from it")
	}
}

func TestFourPlatformsCoexistOnOneEndpoint(t *testing.T) {
	// The seam, at the front door: each host is told apart by its own header (or,
	// for Azure, by elimination) and authenticated with its OWN secret, so no
	// host's hook can forge another's.
	q := queue.NewFakeProducer()
	h := NewHandler("gh-secret", q, dedupe.NewMemoryStore(time.Hour), glLogger(), "cavixcode").
		WithGitLab("gl-secret").
		WithBitbucket("bb-secret").
		WithAzure("az-secret")

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

	req = httptest.NewRequest(http.MethodPost, "/webhook", strings.NewReader(azBody))
	req.Header.Set(AzurePlatformHeader, AzurePlatformValue)
	req.Header.Set("Authorization", azureBasic("cavix", "az-secret"))
	h.ServeHTTP(httptest.NewRecorder(), req)

	if q.Len() != 4 {
		t.Fatalf("enqueued %d jobs, want 4", q.Len())
	}
	seen := map[string]bool{}
	for _, j := range q.Jobs() {
		seen[j.Platform] = true
	}
	for _, p := range []string{
		canonical.PlatformGitHub,
		canonical.PlatformGitLab,
		canonical.PlatformBitbucket,
		canonical.PlatformAzureDevOps,
	} {
		if !seen[p] {
			t.Fatalf("missing platform %q", p)
		}
	}
}
