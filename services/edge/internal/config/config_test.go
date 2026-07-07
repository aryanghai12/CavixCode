package config

import (
	"testing"
)

func TestLoad_RedisURL_ManagedWithAuthAndTLS(t *testing.T) {
	t.Setenv("CAVIX_WEBHOOK_SECRET", "s")
	t.Setenv("CAVIX_REDIS_URL", "rediss://default:p%40ss@my-redis.example.com:6380")

	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.RedisAddr != "my-redis.example.com:6380" {
		t.Errorf("RedisAddr = %q", c.RedisAddr)
	}
	if c.RedisUsername != "default" {
		t.Errorf("RedisUsername = %q", c.RedisUsername)
	}
	if c.RedisPassword != "p@ss" { // URL-decoded
		t.Errorf("RedisPassword = %q", c.RedisPassword)
	}
	if !c.RedisTLS {
		t.Error("RedisTLS should be true for rediss://")
	}
}

func TestLoad_HonorsPORT(t *testing.T) {
	t.Setenv("CAVIX_WEBHOOK_SECRET", "s")
	t.Setenv("PORT", "10000")

	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.Addr != ":10000" {
		t.Errorf("Addr = %q, want :10000 (from $PORT)", c.Addr)
	}
}

func TestLoad_DiscreteRedisVars_NoTLSByDefault(t *testing.T) {
	t.Setenv("CAVIX_WEBHOOK_SECRET", "s")
	t.Setenv("CAVIX_REDIS_ADDR", "127.0.0.1:6379")
	t.Setenv("CAVIX_REDIS_PASSWORD", "pw")

	c, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.RedisAddr != "127.0.0.1:6379" || c.RedisPassword != "pw" || c.RedisTLS {
		t.Errorf("got addr=%q pw=%q tls=%v", c.RedisAddr, c.RedisPassword, c.RedisTLS)
	}
}
