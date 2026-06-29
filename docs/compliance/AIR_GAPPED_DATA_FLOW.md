# Air-gapped data flow — and proof nothing leaves the cluster

This document describes how Cavix processes code with **zero outbound network
calls**, and how to independently verify it.

## The data flow (air-gapped mode)

```
        ┌────────────────────────── customer Kubernetes namespace "cavix" ──────────────────────────┐
        │                                                                                            │
 PR ───▶ edge (webhook) ──XADD──▶ Redis ──▶ orchestrator ──▶ sandbox (gVisor, no egress)            │
 (in-cluster                                  │  clone PR commit (in-cluster SCM only)               │
  SCM/mirror)                                 │  Stage 3/4/5/6 analysis (in-process)                 │
        ▲                                     │  Stage 7 context ──▶ gateway ──▶ cavix-model (vLLM)  │
        │                                     │  Stage 8 agents  ──▶ gateway ──▶ cavix-model         │
        │                                     │  Stage 10 verify  (sandbox, no egress)               │
        └──────── post review ◀───────────────┘  Stage 13 teardown + zero-retention purge           │
        (in-cluster SCM API)                                                                         │
        └────────────────────────────────────────────────────────────────────────────────────────────┘
                       ⛔  no arrow crosses the namespace boundary to the internet
```

Every box is a pod in the `cavix` namespace. The only LLM is `cavix-model`
(a self-hosted open model with an OpenAI-compatible API). Source code is cloned
into an ephemeral sandbox, analyzed, sent **only** to the in-cluster model, and
purged. The SCM is the customer's own in-cluster server (GitLab/Bitbucket DC/
Azure DevOps Server) or a mirror.

## Two independent layers enforce "no egress"

1. **Kernel / CNI — NetworkPolicy** (`cavix-default-deny-egress`): `egress: []`
   for every Cavix pod. A second policy permits only DNS + in-cluster services
   (model, Postgres, Redis, peers). **No rule references `0.0.0.0/0`.** A packet
   to the internet is dropped by the CNI before it leaves the node.

2. **Application — gateway EgressGuard**: every outbound `fetch` in Cavix goes
   through `createGuardedFetch(allowlist)`. In air-gapped mode the allowlist
   contains only the in-cluster model host (plus loopback / `*.svc`). Any other
   host throws `EgressBlockedError` — even a mis-configured URL or a compromised
   dependency cannot exfiltrate. (Unit-proven in
   `packages/gateway/test/airgap.test.ts`.)

Defense in depth: layer 1 stops the packet; layer 2 stops the call from ever
being made. Either alone is sufficient; together they are belt-and-suspenders.

## Prove it

```bash
# 1. The policy denies egress and names no external CIDR.
kubectl -n cavix get networkpolicy cavix-default-deny-egress -o yaml
#    spec.egress: []

# 2. From inside a Cavix pod, the internet is unreachable.
kubectl -n cavix exec deploy/cavix-orchestrator -- \
  sh -c 'wget -T3 -qO- https://api.anthropic.com || echo BLOCKED'
#    → BLOCKED

# 3. The in-cluster model IS reachable (inference works).
kubectl -n cavix exec deploy/cavix-orchestrator -- \
  sh -c 'wget -T3 -qO- http://cavix-model.cavix.svc.cluster.local:8000/health'
#    → ok

# 4. The application guard refuses cloud hosts even if the policy were absent.
npm test -w @cavix/gateway   # airgap.test.ts: cloud hosts throw, model reached
```

## Licensing & updates (no phone-home)

The license is an **offline Ed25519-signed** file (`@cavix/license`); verification
is pure crypto with the vendor public key shipped in the image — no activation
call. Image signatures (cosign keypair) are verified offline at admission. Model
weights and image updates arrive via the customer's registry mirror.

## What is persisted

In zero-retention mode (default for regulated installs) **no customer code
persists** after a review: the sandbox is destroyed and the purge is verified
(`@cavix/zero-retention`). Only metadata — finding counts, rule ids, file paths,
line numbers, severities — may be stored; code bodies, suggestions, and evidence
snippets are stripped (`metadataOnly`).
