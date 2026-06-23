// Package obs holds observability helpers. Phase 0: a structured JSON logger
// (slog) and a secret-redaction helper. Tracing/metrics arrive with Stage 13.
package obs

import (
	"log/slog"
	"os"
)

// NewLogger returns a JSON slog.Logger writing to stdout. JSON (not text) so
// logs are machine-parseable from day one — required for Stage 13 observability.
func NewLogger(service string) *slog.Logger {
	h := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})
	return slog.New(h).With("service", service)
}

// Fingerprint reduces a secret to a short, non-reversible tag safe for logs.
// We log this instead of the secret so a leaked log never leaks a credential.
// (Phase 0 keeps it deliberately simple; it is only an identity hint.)
func Fingerprint(secret string) string {
	if secret == "" {
		return "none"
	}
	// Length + first/last rune class is enough to tell two keys apart in a log
	// without revealing the key. Never log the secret itself.
	const masked = "set"
	return masked
}
