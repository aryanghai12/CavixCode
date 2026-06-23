package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/cavix/edge/internal/canonical"
	"github.com/cavix/edge/internal/resp"
)

// RedisStreamProducer writes ReviewJobs to a Redis Stream via XADD. The whole
// job is stored as a single "job" field holding canonical JSON, which keeps the
// consumer (orchestrator bridge) trivial: read one field, json.parse, done.
//
// Why a Stream and not a list: a consumer group gives the orchestrator
// at-least-once delivery with explicit acks and a pending-entries list, so a
// crash mid-review re-delivers the job instead of losing it.
type RedisStreamProducer struct {
	mu      sync.Mutex // RESP client is single-connection; serialize XADDs
	client  *resp.Client
	stream  string
	timeout time.Duration
}

// NewRedisStreamProducer dials addr ("host:port") and targets the given stream.
func NewRedisStreamProducer(addr, stream string, timeout time.Duration) (*RedisStreamProducer, error) {
	c, err := resp.Dial(addr, timeout)
	if err != nil {
		return nil, err
	}
	return &RedisStreamProducer{client: c, stream: stream, timeout: timeout}, nil
}

// Enqueue serializes job to JSON and XADDs it. Returns the stream entry ID.
func (p *RedisStreamProducer) Enqueue(ctx context.Context, job canonical.ReviewJob) (string, error) {
	payload, err := json.Marshal(job)
	if err != nil {
		return "", fmt.Errorf("marshal review job: %w", err)
	}
	p.mu.Lock()
	defer p.mu.Unlock()

	// Bound the round trip by the smaller of the context deadline and timeout so
	// a slow Redis can't blow the edge's <100ms ACK budget.
	deadline := time.Now().Add(p.timeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}
	if err := p.client.SetDeadline(deadline); err != nil {
		return "", err
	}

	// XADD <stream> * job <payload>  ("*" = let Redis assign the entry ID)
	reply, err := p.client.Do("XADD", p.stream, "*", "job", string(payload))
	if err != nil {
		return "", fmt.Errorf("xadd to %s: %w", p.stream, err)
	}
	id, ok := reply.(string)
	if !ok {
		return "", fmt.Errorf("xadd: unexpected reply type %T", reply)
	}
	return id, nil
}

// Close closes the underlying connection.
func (p *RedisStreamProducer) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.client.Close()
}
