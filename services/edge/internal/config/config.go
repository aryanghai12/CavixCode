// Package config loads edge settings from the environment. Config over hardcode:
// nothing here is baked into the binary, so the same image runs in dev, cloud,
// and air-gapped self-host with only env changes.
package config

import (
	"errors"
	"net"
	"net/url"
	"os"
	"time"
)

// Config holds all edge runtime settings.
type Config struct {
	Addr          string        // HTTP listen address, e.g. ":8080"
	WebhookSecret string        // GitHub App webhook secret (HMAC key)
	RedisAddr     string        // "host:port"; empty → in-memory fake queue
	RedisUsername string        // Redis ACL username (managed Redis)
	RedisPassword string        // Redis AUTH password (managed Redis)
	RedisTLS      bool          // use TLS (rediss://)
	StreamKey     string        // Redis Stream to XADD jobs onto
	DedupeTTL     time.Duration // idempotency window
	EnqueueDialMs time.Duration // dial timeout for Redis
	BotHandle     string        // mention handle: "@<handle> review" (e.g. "cavixcode")
}

// Load reads config from env with safe defaults.
func Load() (Config, error) {
	// Honor $PORT so managed hosts (Render/Railway/Fly) work with no extra config.
	addr := os.Getenv("CAVIX_EDGE_ADDR")
	if addr == "" {
		if p := os.Getenv("PORT"); p != "" {
			addr = ":" + p
		} else {
			addr = ":8080"
		}
	}

	c := Config{
		Addr:          addr,
		WebhookSecret: os.Getenv("CAVIX_WEBHOOK_SECRET"),
		StreamKey:     getenv("CAVIX_STREAM_KEY", "cavix:reviewjobs"),
		DedupeTTL:     24 * time.Hour,
		EnqueueDialMs: 3 * time.Second,
		BotHandle:     getenv("CAVIX_BOT_HANDLE", "cavix"),
	}

	// Redis: prefer a full URL (managed Redis), else discrete host:port + auth vars.
	if redisURL := firstNonEmpty(os.Getenv("CAVIX_REDIS_URL"), os.Getenv("REDIS_URL")); redisURL != "" {
		if u, err := url.Parse(redisURL); err == nil {
			port := u.Port()
			if port == "" {
				port = "6379"
			}
			c.RedisAddr = net.JoinHostPort(u.Hostname(), port)
			c.RedisUsername = u.User.Username()
			if pw, ok := u.User.Password(); ok {
				c.RedisPassword = pw
			}
			c.RedisTLS = u.Scheme == "rediss"
		}
	} else {
		c.RedisAddr = os.Getenv("CAVIX_REDIS_ADDR")
		c.RedisUsername = os.Getenv("CAVIX_REDIS_USERNAME")
		c.RedisPassword = os.Getenv("CAVIX_REDIS_PASSWORD")
		c.RedisTLS = os.Getenv("CAVIX_REDIS_TLS") == "true"
	}

	if c.WebhookSecret == "" {
		// Fail closed: without a secret we cannot verify webhooks, so refuse to
		// start rather than accept unauthenticated traffic.
		return Config{}, errors.New("CAVIX_WEBHOOK_SECRET is required")
	}
	return c, nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
