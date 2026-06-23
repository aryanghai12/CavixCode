package webhook

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"strings"
)

// SignatureHeader is the header GitHub uses for the HMAC-SHA256 signature.
const SignatureHeader = "X-Hub-Signature-256"

// VerifySignature reports whether sig authenticates body under secret.
//
// GitHub sends the signature as "sha256=<hex>". We recompute HMAC-SHA256 over
// the raw request body and compare using hmac.Equal, which is constant-time —
// this prevents a timing side channel that could let an attacker recover the
// MAC byte by byte. Verification happens BEFORE the body is parsed or trusted.
//
// An empty secret returns false: refusing to "verify" against no secret is a
// fail-closed default that prevents accidentally accepting unsigned traffic.
func VerifySignature(secret, sig string, body []byte) bool {
	if secret == "" {
		return false
	}
	const prefix = "sha256="
	if !strings.HasPrefix(sig, prefix) {
		return false
	}
	want, err := hex.DecodeString(strings.TrimPrefix(sig, prefix))
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	got := mac.Sum(nil)
	return hmac.Equal(got, want)
}
