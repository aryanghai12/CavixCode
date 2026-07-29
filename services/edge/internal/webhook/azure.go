package webhook

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/cavix/edge/internal/canonical"
)

// Azure DevOps ingestion, normalized into the same canonical ReviewJob as the
// other three hosts.
//
// PULL REQUEST EVENTS ONLY, and, as with Bitbucket, that is a refusal rather
// than an omission. A chat command has to be authorized before it spends a
// customer's model budget, and answering "may this arbitrary user push here?" on
// Azure needs Graph or Security-namespace scopes a review bot should not hold.
// So no Azure comment ever becomes a job: `RestAzureClient.commandsAllowed`
// returns false and this file has no comment handler.
//
// AUTHENTICATION IS DIFFERENT HERE, and it is the only place the edge's shape
// bends for a platform.
//
// GitHub and Bitbucket sign the body with HMAC-SHA256. GitLab sends a shared
// token in a header. Azure DevOps service hooks do NEITHER: the only credential
// they can carry is HTTP Basic authentication, configured on the subscription.
// So the check here is a constant-time comparison of that Basic credential
// against the configured secret, and it still happens BEFORE the body is parsed
// or trusted, which is the property that actually matters.
//
// The consequence is worth stating plainly: a Basic credential authenticates the
// SENDER but not the BODY, so an operator who puts this endpoint behind a proxy
// that logs URLs or headers has leaked the secret. That is why it is a distinct
// secret per platform, exactly as the other three are.

// AzurePlatformHeader lets an operator name the platform explicitly.
//
// Azure's web hook configuration has an HTTP-headers box, so this is one line to
// set, and it is the unambiguous route. It is optional: a request carrying none
// of the other hosts' headers is treated as Azure when Azure is configured, so
// the common setup works with nothing but the Basic credential.
const AzurePlatformHeader = "X-Cavix-Platform"

// AzurePlatformValue is what that header must say.
const AzurePlatformValue = "azure-devops"

// azureTriggerEvents are the pull request events worth a review.
//
// "git.pullrequest.updated" fires for a new push AND for a title or description
// edit, so the idempotency key (which binds to the head commit) is what stops an
// edited description from costing a second review.
var azureTriggerEvents = map[string]bool{
	"git.pullrequest.created": true,
	"git.pullrequest.updated": true,
}

// azurePullRequestEvent is the strict subset we consume. Same allow-list
// discipline as the other normalizers: unlisted fields never reach the
// orchestrator.
type azurePullRequestEvent struct {
	EventType string `json:"eventType"`
	Resource  struct {
		PullRequestID int    `json:"pullRequestId"`
		Title         string `json:"title"`
		Status        string `json:"status"`
		IsDraft       bool   `json:"isDraft"`
		SourceRefName string `json:"sourceRefName"`
		TargetRefName string `json:"targetRefName"`
		LastMergeSourceCommit struct {
			CommitID string `json:"commitId"`
		} `json:"lastMergeSourceCommit"`
		LastMergeTargetCommit struct {
			CommitID string `json:"commitId"`
		} `json:"lastMergeTargetCommit"`
		CreatedBy struct {
			UniqueName  string `json:"uniqueName"`
			DisplayName string `json:"displayName"`
		} `json:"createdBy"`
		Repository struct {
			Name    string `json:"name"`
			Project struct {
				Name string `json:"name"`
			} `json:"project"`
		} `json:"repository"`
	} `json:"resource"`
	ResourceContainers struct {
		Account struct {
			// The organisation's GUID. Its NAME is what URLs need, and the
			// payload only carries the name under `baseUrl`.
			BaseURL string `json:"baseUrl"`
		} `json:"account"`
	} `json:"resourceContainers"`
}

// VerifyAzureBasic reports whether the Authorization header carries the
// configured Basic credential.
//
// Constant-time on the decoded credential, for the same reason every other
// comparison in this package is: a byte-by-byte early exit is a timing oracle
// that recovers the secret one character at a time. Fail-closed on an empty
// secret, so a deployment that has not configured Azure accepts nothing.
func VerifyAzureBasic(secret, authorization string) bool {
	if secret == "" {
		return false
	}
	const prefix = "Basic "
	if len(authorization) < len(prefix) || !strings.EqualFold(authorization[:len(prefix)], prefix) {
		return false
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(authorization[len(prefix):]))
	if err != nil {
		return false
	}
	// Azure sends "username:password". The secret is compared against the
	// password half, so an operator may put anything in the username box.
	creds := string(raw)
	idx := strings.IndexByte(creds, ':')
	if idx < 0 {
		return false
	}
	password := creds[idx+1:]
	return subtle.ConstantTimeCompare([]byte(password), []byte(secret)) == 1
}

// NormalizeAzurePullRequest converts a pull request event into a job.
func NormalizeAzurePullRequest(body []byte, deliveryID string) (canonical.ReviewJob, error) {
	var ev azurePullRequestEvent
	if err := json.Unmarshal(body, &ev); err != nil {
		return canonical.ReviewJob{}, fmt.Errorf("decode azure payload: %w", err)
	}
	if !azureTriggerEvents[ev.EventType] {
		return canonical.ReviewJob{}, ErrNotTrigger
	}
	// A pull request that has completed or been abandoned is not a review
	// candidate even when the event says "updated".
	if st := strings.ToLower(ev.Resource.Status); st == "completed" || st == "abandoned" {
		return canonical.ReviewJob{}, ErrNotTrigger
	}

	org := azureOrgFromBaseURL(ev.ResourceContainers.Account.BaseURL)
	project := ev.Resource.Repository.Project.Name
	repo := ev.Resource.Repository.Name
	head := ev.Resource.LastMergeSourceCommit.CommitID

	if ev.Resource.PullRequestID == 0 || org == "" || project == "" || repo == "" || head == "" {
		return canonical.ReviewJob{}, errors.New("payload missing required fields (pr id / org / project / repo / head commit)")
	}

	// "organization/project/repository". The orchestrator's refFromJob splits at
	// the LAST slash, giving owner "organization/project" and repo "repository",
	// which is exactly the shape Azure's REST paths want. Splitting at the first
	// slash instead is the bug that broke nested GitLab groups.
	full := fmt.Sprintf("%s/%s/%s", org, project, repo)

	author := ev.Resource.CreatedBy.UniqueName
	if author == "" {
		author = ev.Resource.CreatedBy.DisplayName
	}

	job := canonical.ReviewJob{
		SchemaVersion: canonical.SchemaVersion,
		Platform:      canonical.PlatformAzureDevOps,
		DeliveryID:    deliveryID,
		Org:           org,
		Repo:          full,
		// Azure repository ids are GUIDs and RepoID is numeric. The idempotency
		// fingerprint already folds in the full name, so 0 costs nothing rather
		// than mangling a GUID into an int. Bitbucket makes the same trade.
		RepoID:   0,
		PRNumber: ev.Resource.PullRequestID,
		Action:   ev.EventType,
		HeadSHA:  head,
		BaseSHA:  ev.Resource.LastMergeTargetCommit.CommitID,
		Priority: canonical.DefaultPriority,
		Title:    ev.Resource.Title,
		Author:   author,
		// No installation to mint a token from; credentials are per workspace.
		InstallationID: 0,
		EnqueuedAt:     time.Now().UTC().Format(time.RFC3339),
		Trigger:        canonical.TriggerPullRequest,
	}
	job.IdempotencyKey = azureKey(job)
	return job, nil
}

// azureOrgFromBaseURL pulls the organisation NAME out of the account base URL.
//
// The payload's account entry carries a GUID for the id and the organisation URL
// for the name, and it is the name that every REST path needs. Both hosted
// shapes appear in the wild: the current "https://dev.azure.com/acme/" and the
// legacy "https://acme.visualstudio.com/", and a self-hosted server puts the
// collection last ("https://tfs.acme.local/tfs/DefaultCollection/").
func azureOrgFromBaseURL(baseURL string) string {
	s := strings.TrimSpace(baseURL)
	if s == "" {
		return ""
	}
	s = strings.TrimSuffix(s, "/")
	s = strings.TrimPrefix(strings.TrimPrefix(s, "https://"), "http://")
	if s == "" {
		return ""
	}
	parts := strings.Split(s, "/")
	host := parts[0]
	// Legacy: the organisation is the subdomain.
	if strings.HasSuffix(host, ".visualstudio.com") {
		return strings.TrimSuffix(host, ".visualstudio.com")
	}
	// Hosted and on-premises: the last path segment names the organisation or
	// the collection.
	if len(parts) > 1 {
		last := parts[len(parts)-1]
		if last != "" {
			return last
		}
	}
	return ""
}

// azureKey fingerprints the logical unit of work. Like the Bitbucket key it
// folds in the repository FULL NAME rather than a numeric id, because Azure
// repository ids are GUIDs and RepoID is 0 here.
func azureKey(j canonical.ReviewJob) string {
	h := sha256.New()
	fmt.Fprintf(h, "%s|%d|%s|%s", j.Repo, j.PRNumber, j.Action, j.HeadSHA)
	return fmt.Sprintf("%x", h.Sum(nil))
}
