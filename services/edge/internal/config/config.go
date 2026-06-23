// Package config loads edge settings from the environment. Config over hardcode:
// nothing here is baked into the binary, so the same image runs in dev, cloud,
// and air-gapped self-host with only env changes.
package config

import (
	"errors"
	"os"
	"time"
)

// Config holds all edge runtime settings.
type Config struct {
	Addr          string        // HTTP listen address, e.g. ":8080"
	WebhookSecret string        // GitHub App webhook secret (HMAC key)
	RedisAddr     string        // "host:port"; empty → in-memory fake queue
	StreamKey     string        // Redis Stream to XADD jobs onto
	DedupeTTL     time.Duration // idempotency window
	EnqueueDialMs time.Duration // dial timeout for Redis
}

// Load reads config from env with safe defaults.
func Load() (Config, error) {
	c := Config{
		Addr:          getenv("CAVIX_EDGE_ADDR", ":8080"),
		WebhookSecret: os.Getenv("CAVIX_WEBHOOK_SECRET"),
		RedisAddr:     os.Getenv("CAVIX_REDIS_ADDR"),
		StreamKey:     getenv("CAVIX_STREAM_KEY", "cavix:reviewjobs"),
		DedupeTTL:     24 * time.Hour,
		EnqueueDialMs: 2 * time.Second,
	}
	if c.WebhookSecret == "" {
		// Fail closed: without a secret we cannot verify webhooks, so refuse to
		// start rather than accept unauthenticated traffic.
		return Config{}, errors.New("CAVIX_WEBHOOK_SECRET is required")
	}
	return c, nil
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
