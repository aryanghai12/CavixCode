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
	BotHandle     string        // mention handle(s), comma-separated: "@<handle> review"
	// GitLabToken is the shared secret set on a GitLab project hook. Empty means
	// GitLab ingestion is off, which is the default: a deployment that has not
	// configured it rejects GitLab deliveries rather than trusting them.
	GitLabToken string
	// BitbucketSecret is the HMAC secret set on a Bitbucket Cloud webhook. Empty
	// means Bitbucket ingestion is off, which is the default.
	BitbucketSecret string
	// AzureSecret is the PASSWORD half of the Basic credential configured on an
	// Azure DevOps service hook subscription. Azure web hooks sign nothing, so
	// this is the only credential they can carry. Empty means Azure ingestion is
	// off, which is the default.
	AzureSecret string
	// ControlPlaneURL and InternalToken let the edge forward GitHub App
	// installation lifecycle events to the service that owns the installation
	// record. Both empty means installation events are acknowledged and dropped,
	// which is the right behaviour for a deployment with no control-plane and was
	// the behaviour of every deployment before this existed.
	ControlPlaneURL string
	InternalToken   string
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
		Addr:            addr,
		WebhookSecret:   os.Getenv("CAVIX_WEBHOOK_SECRET"),
		GitLabToken:     os.Getenv("CAVIX_GITLAB_WEBHOOK_SECRET"),
		BitbucketSecret: os.Getenv("CAVIX_BITBUCKET_WEBHOOK_SECRET"),
		AzureSecret:     os.Getenv("CAVIX_AZURE_WEBHOOK_SECRET"),
		StreamKey:       getenv("CAVIX_STREAM_KEY", "cavix:reviewjobs"),
		DedupeTTL:       24 * time.Hour,
		EnqueueDialMs:   3 * time.Second,
		// Default answers to BOTH the GitHub App slug people actually type
		// ("@cavixcode review") and the short alias ("@cavix review"). Override
		// with CAVIX_BOT_HANDLE if your App slug differs.
		BotHandle:       getenv("CAVIX_BOT_HANDLE", "cavixcode,cavix"),
		ControlPlaneURL: os.Getenv("CAVIX_CONTROL_PLANE_URL"),
		InternalToken:   os.Getenv("CAVIX_INTERNAL_TOKEN"),
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
