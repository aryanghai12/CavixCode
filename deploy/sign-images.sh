#!/usr/bin/env bash
# Sign (and verify) Cavix images with cosign (Sigstore). For air-gapped installs,
# use keypair signing (not keyless/Fulcio) so verification needs no internet.
#
#   COSIGN_PASSWORD=… ./sign-images.sh registry.internal/cavix 0.3.0 cosign.key
set -euo pipefail

REGISTRY="${1:?usage: sign-images.sh <registry> <tag> <cosign.key>}"
TAG="${2:?missing tag}"
KEY="${3:?missing cosign private key}"
PUB="${KEY%.key}.pub"

IMAGES=(edge orchestrator control-plane model-runtime)

echo "Signing Cavix ${TAG} images in ${REGISTRY} with ${KEY}"
for img in "${IMAGES[@]}"; do
  ref="${REGISTRY}/${img}:${TAG}"
  echo "  → cosign sign ${ref}"
  cosign sign --key "${KEY}" --yes "${ref}"
done

echo "Verifying signatures with ${PUB} (offline-capable)…"
for img in "${IMAGES[@]}"; do
  ref="${REGISTRY}/${img}:${TAG}"
  cosign verify --key "${PUB}" "${ref}" >/dev/null && echo "  ✓ ${ref}"
done

cat <<EOF

Enforce at admission (cluster blocks unsigned images) with a Sigstore policy, e.g.
Kyverno verifyImages using the public key in ${PUB}. In air-gapped clusters this
verification is fully offline (keypair, not keyless).
EOF
