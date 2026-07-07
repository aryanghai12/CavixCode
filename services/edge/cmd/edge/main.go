// Command edge is the Cavix Stage 0 ingestion service: a GitHub App webhook
// receiver that verifies, normalizes, dedupes, and enqueues pull_request events
// for the orchestrator, acknowledging GitHub in well under 100ms.
package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/cavix/edge/internal/config"
	"github.com/cavix/edge/internal/dedupe"
	"github.com/cavix/edge/internal/obs"
	"github.com/cavix/edge/internal/queue"
	"github.com/cavix/edge/internal/resp"
	"github.com/cavix/edge/internal/webhook"
)

func main() {
	log := obs.NewLogger("edge")

	cfg, err := config.Load()
	if err != nil {
		log.Error("config load failed", "err", err.Error())
		os.Exit(1)
	}

	// Choose the queue backend. Empty CAVIX_REDIS_ADDR → in-memory fake, which
	// is handy for local smoke tests; production sets the Redis address.
	var producer queue.Producer
	if cfg.RedisAddr == "" {
		log.Warn("CAVIX_REDIS_ADDR empty — using in-memory queue (jobs are NOT durable)")
		producer = queue.NewFakeProducer()
	} else {
		p, err := queue.NewRedisStreamProducerWithOptions(cfg.RedisAddr, cfg.StreamKey, resp.Options{
			Username: cfg.RedisUsername,
			Password: cfg.RedisPassword,
			TLS:      cfg.RedisTLS,
			Timeout:  cfg.EnqueueDialMs,
		})
		if err != nil {
			log.Error("redis connect failed", "addr", cfg.RedisAddr, "err", err.Error())
			os.Exit(1)
		}
		producer = p
		log.Info("connected to redis stream", "addr", cfg.RedisAddr, "stream", cfg.StreamKey, "tls", cfg.RedisTLS)
	}
	defer producer.Close()

	dd := dedupe.NewMemoryStore(cfg.DedupeTTL)
	handler := webhook.NewHandler(cfg.WebhookSecret, producer, dd, log, cfg.BotHandle)

	mux := http.NewServeMux()
	mux.Handle("/webhook", handler)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	srv := &http.Server{
		Addr:    cfg.Addr,
		Handler: mux,
		// Conservative timeouts: the edge does tiny, fast work; anything slow is
		// suspicious. These bound resource use under hostile/slowloris clients.
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	// Graceful shutdown on SIGINT/SIGTERM so in-flight ACKs complete.
	go func() {
		log.Info("edge listening", "addr", cfg.Addr, "secret", obs.Fingerprint(cfg.WebhookSecret))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server error", "err", err.Error())
			os.Exit(1)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	log.Info("shutting down")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		log.Error("graceful shutdown failed", "err", err.Error())
	}
}
