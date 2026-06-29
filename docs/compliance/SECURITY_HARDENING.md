# Security hardening

Cavix runs untrusted code and handles private source, so isolation and least
privilege are designed in, not bolted on.

## Runtime / pod hardening (Helm defaults)
- `runAsNonRoot: true`, `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`
- `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault`
- `automountServiceAccountToken: false` (no ambient kube API access)
- Writable scratch is an in-memory `emptyDir` (`medium: Memory`), wiped on exit
- Namespace label `pod-security.kubernetes.io/enforce: restricted`

## Sandbox (Stage 2/10) — untrusted code execution
- gVisor/Firecracker `runtimeClassName` (kernel isolation) for self-host;
  Docker `--network none`, CPU/mem/pids caps, read-only rootfs + tmpfs `/work`
- **No network egress** from the sandbox; hard wall-clock cap; ephemeral —
  destroyed after every job (`packages/sandbox`, `packages/zero-retention`)

## Network
- Default-deny ingress + egress NetworkPolicies; only DNS + in-cluster services
  permitted; no `0.0.0.0/0` (see AIR_GAPPED_DATA_FLOW.md)
- Application-layer EgressGuard as a second barrier

## Secrets
- BYOK keys, webhook secrets, and tokens are never logged — only non-reversible
  fingerprints (`gateway keyFingerprint`, `edge obs.Fingerprint`)
- Webhook authenticity: constant-time HMAC-SHA256, fail-closed
- License/SAML/image-signing keys verified with public keys only on the cluster

## Supply chain
- cosign-signed images; offline keypair verification at admission
- Zero/minimal third-party deps (stdlib-first Go edge; fetch-based providers)
- CI gates: vet/lint, typecheck, tests, eval F1 regression gate

## Data handling
- Zero-retention mode: verified purge of all customer code post-review;
  metadata-only persistence
- Deterministic findings (secrets/SAST/policy/telemetry) cannot be dropped by an
  LLM; policy findings are immutable
