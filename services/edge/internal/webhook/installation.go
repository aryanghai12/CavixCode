package webhook

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// GitHub App installation lifecycle.
//
// These events are how Cavix learns WHAT it is allowed to read, and nothing was
// listening for them. Repository access was discovered only by polling
// /user/installations the next time somebody happened to open the Repositories
// page, so between two page loads Cavix's idea of its own reach and GitHub's
// could disagree with nothing anywhere noticing. Every review decision made from
// the stale side is wrong: either a repository is reviewed after the owner
// revoked access, or one is ignored after they granted it.
//
// The repository picker on GitHub's install screen is the control customers
// actually use. `installation_repositories` IS that picker's output. Not
// consuming it meant the one setting they were told to use had no effect until
// something else happened to refresh.

// InstallationAction is the lifecycle transition a delivery reports.
type InstallationAction string

const (
	InstallCreated           InstallationAction = "created"
	InstallDeleted           InstallationAction = "deleted"
	InstallSuspended         InstallationAction = "suspend"
	InstallUnsuspended       InstallationAction = "unsuspend"
	InstallPermissionsAccept InstallationAction = "new_permissions_accepted"
	InstallReposAdded        InstallationAction = "added"
	InstallReposRemoved      InstallationAction = "removed"
	InstallTargetRenamed     InstallationAction = "renamed"
)

// ErrNotInstallationEvent marks a well-formed delivery that carries no
// installation change, so the caller can ACK it rather than reject it.
var ErrNotInstallationEvent = errors.New("not an installation lifecycle event")

// RepoRef is the minimum needed to key a repository for its whole lifetime.
//
// The numeric ID is the identity, NOT the full name. Repositories get renamed,
// and anything keyed by "owner/name" is orphaned the moment that happens: the
// old row goes stale and a new one appears with no history, no settings and no
// finding ledger behind it.
type RepoRef struct {
	ID       int64  `json:"id"`
	FullName string `json:"full_name"`
	Private  bool   `json:"private"`
}

// InstallationEvent is the strict subset of GitHub's installation payloads Cavix
// consumes. Unlisted fields are dropped by encoding/json, the same allow-list
// discipline pullRequestEvent uses, so unexpected or hostile fields cannot reach
// downstream code.
type InstallationEvent struct {
	Action       string `json:"action"`
	Installation struct {
		ID      int64 `json:"id"`
		Account struct {
			ID    int64  `json:"id"`
			Login string `json:"login"`
			Type  string `json:"type"`
		} `json:"account"`
		RepositorySelection string `json:"repository_selection"`
		SuspendedAt         string `json:"suspended_at"`
		HTMLURL             string `json:"html_url"`
		UpdatedAt           string `json:"updated_at"`
	} `json:"installation"`
	Repositories        []RepoRef `json:"repositories"`
	RepositoriesAdded   []RepoRef `json:"repositories_added"`
	RepositoriesRemoved []RepoRef `json:"repositories_removed"`
	Changes             struct {
		Login struct {
			From string `json:"from"`
		} `json:"login"`
	} `json:"changes"`
	Sender struct {
		Login string `json:"login"`
	} `json:"sender"`
}

// InstallationChange is what the edge hands on: one normalized, host-neutral
// statement about what Cavix may now read.
type InstallationChange struct {
	SchemaVersion  int    `json:"schema_version"`
	DeliveryID     string `json:"delivery_id"`
	Event          string `json:"event"`
	Action         string `json:"action"`
	InstallationID int64  `json:"installation_id"`
	AccountLogin   string `json:"account_login"`
	AccountID      int64  `json:"account_id"`
	AccountType    string `json:"account_type"`
	// "all" means repositories created in future are automatically in scope;
	// "selected" means the set is exactly what was listed. Inferring reach from
	// a repository snapshot instead gets the first case permanently wrong.
	RepositorySelection string    `json:"repository_selection"`
	Suspended           bool      `json:"suspended"`
	HTMLURL             string    `json:"html_url"`
	Repositories        []RepoRef `json:"repositories"`
	Added               []RepoRef `json:"added"`
	Removed             []RepoRef `json:"removed"`
	// PreviousLogin is set on a rename, so stale "owner/name" strings can be
	// rewritten before every permalink in an existing review breaks.
	PreviousLogin string `json:"previous_login,omitempty"`
	// UpdatedAt orders deliveries. They arrive out of order and are redelivered,
	// and an older payload applied on top of a newer one silently reverts the
	// repository set.
	UpdatedAt string `json:"updated_at"`
}

// installationActions are the transitions worth acting on. Anything else is a
// well-formed event Cavix has no work for, and is acknowledged rather than
// rejected: returning an error would make GitHub retry a delivery forever.
var installationActions = map[string]bool{
	string(InstallCreated):           true,
	string(InstallDeleted):           true,
	string(InstallSuspended):         true,
	string(InstallUnsuspended):       true,
	string(InstallPermissionsAccept): true,
	string(InstallReposAdded):        true,
	string(InstallReposRemoved):      true,
	string(InstallTargetRenamed):     true,
}

// NormalizeInstallation parses an installation, installation_repositories or
// installation_target delivery into an InstallationChange.
func NormalizeInstallation(body []byte, deliveryID, event string) (InstallationChange, error) {
	var ev InstallationEvent
	if err := json.Unmarshal(body, &ev); err != nil {
		return InstallationChange{}, fmt.Errorf("decode %s payload: %w", event, err)
	}
	if !installationActions[ev.Action] {
		return InstallationChange{}, ErrNotInstallationEvent
	}
	if ev.Installation.ID == 0 {
		return InstallationChange{}, errors.New("payload missing installation id")
	}

	selection := ev.Installation.RepositorySelection
	if selection != "all" && selection != "selected" {
		// Absent on some deliveries. "selected" is the conservative reading: it
		// claims the narrowest reach, so a wrong guess here under-reaches rather
		// than reviewing a repository nobody granted.
		selection = "selected"
	}

	accountType := ev.Installation.Account.Type
	if accountType != "User" {
		accountType = "Organization"
	}

	// GitHub stamps installation.updated_at on most payloads. Where it does not,
	// arrival time is the best available order, and it is only ever compared
	// against other timestamps from the same source.
	updated := strings.TrimSpace(ev.Installation.UpdatedAt)
	if updated == "" {
		updated = time.Now().UTC().Format(time.RFC3339)
	}

	return InstallationChange{
		SchemaVersion:       1,
		DeliveryID:          deliveryID,
		Event:               event,
		Action:              ev.Action,
		InstallationID:      ev.Installation.ID,
		AccountLogin:        ev.Installation.Account.Login,
		AccountID:           ev.Installation.Account.ID,
		AccountType:         accountType,
		RepositorySelection: selection,
		Suspended:           strings.TrimSpace(ev.Installation.SuspendedAt) != "",
		HTMLURL:             ev.Installation.HTMLURL,
		Repositories:        ev.Repositories,
		Added:               ev.RepositoriesAdded,
		Removed:             ev.RepositoriesRemoved,
		PreviousLogin:       ev.Changes.Login.From,
		UpdatedAt:           updated,
	}, nil
}

// IsInstallationEvent reports whether an X-GitHub-Event header names one of the
// lifecycle events this file handles.
func IsInstallationEvent(event string) bool {
	switch event {
	case "installation", "installation_repositories", "installation_target":
		return true
	}
	return false
}
