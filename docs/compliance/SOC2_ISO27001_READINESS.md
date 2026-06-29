# SOC 2 / ISO 27001 readiness — control mapping

How Cavix's implemented controls map to common SOC 2 (Trust Services Criteria)
and ISO/IEC 27001:2022 Annex A controls. "Evidence" points at the code/config
that implements the control.

| Control area | SOC 2 / ISO 27001 | How Cavix addresses it | Evidence |
|---|---|---|---|
| Access control / least privilege | CC6.1 / A.5.15, A.8.2 | RBAC (owner/admin/reviewer/member) gating every action | `packages/governance` rbac |
| Authentication (SSO) | CC6.1 / A.5.16 | SAML 2.0 assertion verification (signature, audience, validity, replay) | governance saml |
| Provisioning / deprovisioning | CC6.2, CC6.3 / A.5.16 | SCIM 2.0 with idempotent provisioning + soft-delete deactivation | governance scim |
| Audit logging / integrity | CC7.2 / A.8.15 | Tamper-evident hash-chained audit log; `verify()` detects edits | governance audit |
| Encryption in transit | CC6.7 / A.8.24 | TLS to SCM/model; air-gap allows only in-cluster TLS endpoints | helm, egress guard |
| Network segmentation | CC6.6 / A.8.20, A.8.22 | Default-deny ingress+egress NetworkPolicies; namespace isolation | helm networkpolicies |
| Boundary / data exfiltration | CC6.6 / A.8.20 | Two-layer egress control (NetworkPolicy + gateway EgressGuard) | AIR_GAPPED_DATA_FLOW.md |
| Data retention / minimization | CC6.5, P4 / A.8.10 | Zero-retention: verified purge; metadata-only persistence | `packages/zero-retention` |
| Secure SDLC / change mgmt | CC8.1 / A.8.25, A.8.28 | Signed images (cosign), CI lint+typecheck+test gates | deploy/sign-images.sh, ci.yml |
| Vulnerability management | CC7.1 / A.8.8 | Deterministic SAST/secrets + verified findings (Stage 3/10) | deterministic, verifier |
| Cryptographic key mgmt | CC6.1 / A.8.24 | Ed25519 license keys; BYOK per org; secrets never logged | license, gateway |
| Configuration hardening | CC6.1 / A.8.9 | Non-root, read-only rootfs, drop ALL caps, seccomp, no token automount | helm pod security |
| Availability / resilience | A1.1 / A.8.14 | Durable queue + workflow retries; HPA-ready replicas | edge, orchestrator |
| Vendor independence | — | Model-agnostic + self-hostable + air-gapped (no third-party processor) | airgap |

## Audit evidence you can export

- **Access events**: the hash-chained audit log (who did what, when) with an
  integrity proof.
- **Egress posture**: `kubectl get networkpolicy` output + the gateway egress
  test result.
- **Retention attestations**: per-review purge attestations (`clean: true`).
- **Build provenance**: cosign signatures + CI run logs (lint/typecheck/test).

This is *readiness scaffolding*, not a certification. It gives an auditor a clear
map from criteria to implemented, testable controls.
