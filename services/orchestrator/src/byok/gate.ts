// Execution gatekeeper: before reviewing a PR, ask the control-plane whether that
// repo is toggled ON in the dashboard. Only enabled repos get reviewed. Configured
// with the same CAVIX_CONTROL_PLANE_URL + CAVIX_INTERNAL_TOKEN as the BYOK resolver.
//
// It also answers WHICH dashboard workspace owns the repo. That matters: the job's
// `org` is the GitHub owner login ("acme-eng"), while the BYOK key is stored under
// the Cavix workspace name the user signed up with ("Acme"). Looking the key up by
// the GitHub login silently found nothing and every review died with an empty key.

import type { GateDecision } from "../workflow/reviewWorkflow.ts";

export interface RepoGateOptions {
  url: string;
  token: string;
  /** On a control-plane error, review anyway? Default false (fail-closed: skip). */
  failOpen?: boolean;
  /** Attempts per check (default 3). Free hosts cold-start, so one try is too few. */
  attempts?: number;
  /** Backoff between attempts, ms (default 2000). */
  retryDelayMs?: number;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

export type RepoGate = (fullName: string, pr?: number) => Promise<GateDecision>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function makeRepoGate(opts: RepoGateOptions): RepoGate {
  const base = opts.url.replace(/\/$/, "");
  const onError = opts.failOpen ?? false;
  const attempts = Math.max(1, opts.attempts ?? 3);
  const delayMs = opts.retryDelayMs ?? 2000;
  const doFetch = opts.fetchImpl ?? fetch;
  const doSleep = opts.sleepImpl ?? sleep;

  return async (fullName: string, pr?: number): Promise<GateDecision> => {
    // The pull request number is what lets the control-plane answer the
    // PER-PULL-REQUEST allowance as well as the workspace's daily one, on the
    // same call every review already makes. Omitted (an older caller) means the
    // per-PR check is skipped there rather than guessed at.
    const prQuery = typeof pr === "number" && Number.isFinite(pr) ? `&pr=${pr}` : "";
    let lastProblem = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await doFetch(
          `${base}/api/internal/repos/enabled?fullName=${encodeURIComponent(fullName)}${prQuery}`,
          { headers: { authorization: `Bearer ${opts.token}` } },
        );
        if (res.ok) {
          const data = (await res.json()) as {
            enabled?: boolean;
            org?: string;
            reason?: string;
            capReached?: boolean;
          };
          return {
            enabled: data.enabled === true,
            org: data.org,
            // Present when the repo IS connected but this review may not run
            // (suspended workspace, daily allowance spent). The workflow shows it
            // verbatim, so a human learns the real reason instead of being sent
            // to a toggle that is already on.
            ...(data.reason ? { reason: data.reason } : {}),
            // This pull request specifically has spent its reviews. Flagged
            // rather than folded into `reason`, because it is the one refusal
            // that must leave the Cavix check exactly as the last review set it.
            ...(data.capReached === true ? { capReached: true } : {}),
          };
        }
        lastProblem = `HTTP ${res.status}`;
        // 401/404 are configuration mistakes, not cold starts — retrying is pointless.
        if (res.status < 500) {
          opts.logger?.warn("repo gate: control-plane rejected the check", {
            fullName,
            status: res.status,
            hint:
              res.status === 401
                ? "CAVIX_INTERNAL_TOKEN differs between the site and the orchestrator"
                : "the site may not have CAVIX_INTERNAL_TOKEN set at all",
          });
          return { enabled: onError };
        }
      } catch (err) {
        lastProblem = (err as Error).message;
      }
      // A free-tier site sleeps after ~15 min idle; the first request wakes it and
      // times out. Retrying turns that into a working review instead of silence.
      if (attempt < attempts) {
        opts.logger?.warn("repo gate: control-plane unreachable, retrying", {
          fullName,
          attempt,
          of: attempts,
          err: lastProblem,
        });
        await doSleep(delayMs * attempt);
      }
    }
    opts.logger?.warn("repo gate: giving up", { fullName, err: lastProblem, reviewing: onError });
    return { enabled: onError };
  };
}
