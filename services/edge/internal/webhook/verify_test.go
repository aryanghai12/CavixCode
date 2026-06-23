package webhook

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

func sign(secret string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func TestVerifySignature(t *testing.T) {
	secret := "s3cr3t"
	body := []byte(`{"action":"opened"}`)
	good := sign(secret, body)

	cases := []struct {
		name   string
		secret string
		sig    string
		body   []byte
		want   bool
	}{
		{"valid", secret, good, body, true},
		{"tampered body", secret, good, []byte(`{"action":"closed"}`), false},
		{"wrong secret", "other", good, body, false},
		{"missing prefix", secret, hex.EncodeToString([]byte("x")), body, false},
		{"empty secret fails closed", "", good, body, false},
		{"empty sig", secret, "", body, false},
		{"non-hex sig", secret, "sha256=zzzz", body, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := VerifySignature(c.secret, c.sig, c.body); got != c.want {
				t.Fatalf("VerifySignature = %v, want %v", got, c.want)
			}
		})
	}
}
