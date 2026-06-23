// Package queue defines the Producer port the edge writes ReviewJobs to, plus
// an in-memory fake for tests. The real implementation (redis_stream.go) writes
// to a Redis Stream; the orchestrator's bridge consumes from it. Keeping this
// behind an interface is what lets every handler test run without Redis.
package queue

import (
	"context"
	"sync"

	"github.com/cavix/edge/internal/canonical"
)

// Producer accepts canonical ReviewJobs for durable delivery to Stage 1.
type Producer interface {
	// Enqueue persists job and returns the broker-assigned message ID. It must
	// return an error rather than silently dropping — the edge ACKs GitHub only
	// after a successful enqueue, so a failure here surfaces as a 5xx and GitHub
	// retries (no lost jobs).
	Enqueue(ctx context.Context, job canonical.ReviewJob) (string, error)
	Close() error
}

// FakeProducer is an in-memory Producer for tests. Thread-safe.
type FakeProducer struct {
	mu   sync.Mutex
	jobs []canonical.ReviewJob
	// FailWith, when non-nil, makes Enqueue fail — used to test the 5xx path.
	FailWith error
	seq      int
}

// NewFakeProducer returns an empty in-memory producer.
func NewFakeProducer() *FakeProducer { return &FakeProducer{} }

// Enqueue records the job (or returns FailWith if set).
func (f *FakeProducer) Enqueue(_ context.Context, job canonical.ReviewJob) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.FailWith != nil {
		return "", f.FailWith
	}
	f.seq++
	f.jobs = append(f.jobs, job)
	return fakeID(f.seq), nil
}

// Close is a no-op for the fake.
func (f *FakeProducer) Close() error { return nil }

// Jobs returns a copy of everything enqueued so far.
func (f *FakeProducer) Jobs() []canonical.ReviewJob {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]canonical.ReviewJob, len(f.jobs))
	copy(out, f.jobs)
	return out
}

// Len is the number of enqueued jobs.
func (f *FakeProducer) Len() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.jobs)
}

func fakeID(seq int) string {
	return "fake-" + itoa(seq)
}

// itoa avoids pulling strconv into the hot fake path; trivially small ints.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
