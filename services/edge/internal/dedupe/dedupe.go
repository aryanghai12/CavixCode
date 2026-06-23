// Package dedupe provides idempotency: it answers "have we already accepted this
// logical job?" so redelivered webhooks don't trigger duplicate reviews.
//
// The Store interface has an in-memory implementation (single edge instance,
// Phase 0). For a multi-instance edge it should be backed by Redis SET NX EX so
// the check-and-set is atomic across replicas; the interface is identical, so
// that swap does not touch the handler.
package dedupe

import (
	"sync"
	"time"
)

// Store records seen idempotency keys with a TTL.
type Store interface {
	// SeenBefore atomically checks whether key was seen and records it if not.
	// It returns true if the key was ALREADY present (i.e. this is a duplicate).
	SeenBefore(key string) bool
}

// MemoryStore is an in-process Store with TTL eviction. Safe for concurrent use.
type MemoryStore struct {
	mu  sync.Mutex
	ttl time.Duration
	at  map[string]time.Time
	now func() time.Time // injectable clock for deterministic tests
}

// NewMemoryStore returns a Store that forgets keys after ttl.
func NewMemoryStore(ttl time.Duration) *MemoryStore {
	return &MemoryStore{ttl: ttl, at: make(map[string]time.Time), now: time.Now}
}

// SeenBefore is the atomic check-and-set. First call for a key → false (and the
// key is recorded); a second call within the TTL → true.
func (m *MemoryStore) SeenBefore(key string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := m.now()
	m.evictLocked(now)
	if exp, ok := m.at[key]; ok && exp.After(now) {
		return true
	}
	m.at[key] = now.Add(m.ttl)
	return false
}

// evictLocked drops expired keys so the map cannot grow unbounded. Cheap for the
// Phase 0 single-instance volume; the Redis impl offloads this to native TTL.
func (m *MemoryStore) evictLocked(now time.Time) {
	for k, exp := range m.at {
		if !exp.After(now) {
			delete(m.at, k)
		}
	}
}
