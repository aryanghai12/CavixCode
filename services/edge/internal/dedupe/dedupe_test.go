package dedupe

import (
	"testing"
	"time"
)

func TestMemoryStore_SeenBefore(t *testing.T) {
	s := NewMemoryStore(time.Hour)
	if s.SeenBefore("k1") {
		t.Fatal("first sighting must be false")
	}
	if !s.SeenBefore("k1") {
		t.Fatal("second sighting must be true (duplicate)")
	}
	if s.SeenBefore("k2") {
		t.Fatal("a different key must be false")
	}
}

func TestMemoryStore_TTLExpiry(t *testing.T) {
	s := NewMemoryStore(time.Minute)
	now := time.Unix(1000, 0)
	s.now = func() time.Time { return now } // inject deterministic clock

	if s.SeenBefore("k") {
		t.Fatal("first false")
	}
	now = now.Add(30 * time.Second)
	if !s.SeenBefore("k") {
		t.Fatal("still within TTL → duplicate")
	}
	now = now.Add(2 * time.Minute) // past TTL
	if s.SeenBefore("k") {
		t.Fatal("after TTL the key is forgotten → not a duplicate")
	}
}
