// The single in-flight review slot, as the orchestrator sees it.
//
// The control-plane holds the slot; this asks for it and reports back. Like the
// ledger client next door, every call FAILS SOFT, and the direction is chosen
// per call rather than uniformly:
//
//   claim   unreachable  ->  "claimed". A control-plane outage must not stop
//           reviews. The cost is that a push during a review can produce two
//           reviews, which is the behaviour of every deployment before this
//           existed, and is far better than reviewing nothing at all.
//   mayPost unreachable  ->  true. Same reasoning, at the moment where refusing
//           would throw away a review that has already been computed.
//   finish  unreachable  ->  logged. The slot ages out on its own.
//
// Nothing here may throw. A dashboard hiccup that failed the job would make the
// queue retry a review that has already been posted.

import { coerceRun, type ClaimOutcome, type ReviewRun } from "@cavix/review-session";

export interface RunRef {
  org: string;
  /** "owner/repo" as the host names it. */
  repo: string;
  pr: number;
}

export interface RunClient {
  /** Ask for the slot. Never throws. */
  claim(
    ref: RunRef,
    req: { runId: string; headSha: string; baseSha?: string; worker?: string; force?: boolean },
  ): Promise<ClaimOutcome>;
  /** Keep a long review's claim alive. */
  touch(ref: RunRef, runId: string): Promise<void>;
  /** Enter the state nothing may interrupt. */
  beginPosting(ref: RunRef, runId: string): Promise<void>;
  /** Release the slot. */
  finish(
    ref: RunRef,
    runId: string,
    status: "completed" | "failed" | "cancelled",
    reason?: string,
  ): Promise<void>;
  /** Does this run still hold the slot? */
  stillMine(ref: RunRef, runId: string): Promise<boolean>;
  /**
   * Release the slot for a COMMIT, for the failure path.
   *
   * By the time a review has thrown, the run id is out of scope; the head SHA
   * is not. Keyed on the commit so it cannot free a NEWER review's slot: that
   * run holds a different commit, and releasing it would let a third push start
   * a second concurrent review of the same pull request. Without this a failed
   * review wedges the pull request until its claim ages out.
   */
  failForHead(ref: RunRef, headSha: string, reason?: string): Promise<void>;
}

export interface RunClientOptions {
  url: string;
  token: string;
  timeoutMs?: number;
  worker?: string;
  logger?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 4000;

export function makeRunClient(options: RunClientOptions): RunClient {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = options.url.replace(/\/$/, "");

  const call = async (ref: RunRef, action: string, body: Record<string, unknown>): Promise<unknown | null> => {
    const url =
      `${base}/api/internal/reviews/${encodeURIComponent(ref.org)}/` +
      `${ref.repo.split("/").map(encodeURIComponent).join("/")}/${ref.pr}/${action}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        options.logger?.warn("review-run call was refused", { action, repo: ref.repo, pr: ref.pr, status: res.status });
        return null;
      }
      return await res.json();
    } catch (err) {
      options.logger?.warn("review-run call could not be made", {
        action,
        repo: ref.repo,
        pr: ref.pr,
        err: (err as Error).message,
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async claim(ref, req) {
      const body = await call(ref, "claim", { ...req, ...(options.worker ? { worker: options.worker } : {}) });
      if (!body || typeof body !== "object") {
        // Could not ask. Proceed: a control-plane outage must not stop reviews.
        return {
          decision: "claimed",
          run: {
            runId: req.runId,
            headSha: req.headSha,
            status: "running",
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        };
      }
      const b = body as Record<string, unknown>;
      if (b.decision === "duplicate" || b.decision === "wait") {
        const active = coerceRun(b.active);
        return active
          ? ({ decision: b.decision, active } as ClaimOutcome)
          : ({ decision: "claimed", run: fallbackRun(req) } as ClaimOutcome);
      }
      const run = coerceRun(b.run) ?? fallbackRun(req);
      const superseded = coerceRun(b.superseded);
      return superseded ? { decision: "claimed", run, superseded } : { decision: "claimed", run };
    },

    async touch(ref, runId) {
      await call(ref, "touch", { runId });
    },

    async beginPosting(ref, runId) {
      await call(ref, "posting", { runId });
    },

    async finish(ref, runId, status, reason) {
      await call(ref, "finish", { runId, status, ...(reason ? { reason } : {}) });
    },

    async failForHead(ref, headSha, reason) {
      await call(ref, "fail-head", { headSha, ...(reason ? { reason } : {}) });
    },

    async stillMine(ref, runId) {
      const body = await call(ref, "touch", { runId });
      if (!body || typeof body !== "object") return true; // could not ask: proceed
      const run = coerceRun((body as Record<string, unknown>).run);
      // No record at all means run tracking is not enabled on this deployment,
      // which is what every deployment did before this existed. It must never be
      // read as "you were cancelled".
      if (!run) return true;
      return run.runId === runId && (run.status === "running" || run.status === "queued" || run.status === "posting");
    },
  };
}

function fallbackRun(req: { runId: string; headSha: string }): ReviewRun {
  const at = new Date().toISOString();
  return { runId: req.runId, headSha: req.headSha, status: "running", startedAt: at, updatedAt: at };
}
