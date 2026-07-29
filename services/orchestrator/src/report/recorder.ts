// Reporting a finished review back to the control-plane.
//
// This is the step that makes the dashboard real. Without it the orchestrator
// posts a perfect review on GitHub and the site shows "No reviews yet" forever:
// every number on the Overview page, the accept/reject signal the learning loop
// trains on, and the proven-catches feed all read from what is recorded here.
//
// Three rules, all learned the hard way:
//   • It runs AFTER the review is posted, and it can never fail the job. A
//     control-plane that is down or asleep costs the org a dashboard row, not
//     their review.
//   • The org is the WORKSPACE that enabled the repo (from the gate), not the
//     GitHub owner login. Recording under the login files the review against a
//     workspace nobody can see.
//   • Only the fields the store actually keeps are sent. Finding bodies can be
//     kilobytes each and the dashboard never shows them, so they stay out of
//     the payload.

import type { Finding } from "@cavix/core";
import type { RetentionAttestation } from "@cavix/zero-retention";

export interface RecordReviewInput {
  /** Dashboard workspace that owns the repo. */
  org: string;
  /** "owner/repo" as GitHub names it: the store keys repos by this. */
  repo: string;
  pr: number;
  title: string;
  /** Link back to the posted review, so a dashboard row opens the pull request. */
  url?: string;
  findings: Finding[];
  /**
   * What the review cost and how it ran.
   *
   * The workflow has had every one of these since Phase 0 and threw them away
   * at this boundary, so the dashboard could report what Cavix found and never
   * what finding it cost. Cost per review is half of the question anyone
   * renewing a budget is actually asking.
   */
  costUsd?: number;
  model?: string;
  durationMs?: number;
  verifiedCount?: number;
  suppressedCount?: number;
  /**
   * Stage 13. Proof that every sandbox this review provisioned is gone.
   *
   * Safe to send by construction: it carries counts, backend names, a verdict
   * and sentences Cavix wrote, and no path, file name, commit or code. That is
   * checked by a test rather than left to reviewer discipline, because an
   * artefact that quietly starts carrying a workspace path is a retention
   * problem that would sit in a database for years before anyone noticed.
   */
  retention?: RetentionAttestation;
}

export type ReviewRecorder = (input: RecordReviewInput) => Promise<boolean>;

export interface RecorderOptions {
  url: string;
  token: string;
  /** Give up rather than holding the worker open on an unresponsive site. */
  timeoutMs?: number;
  /** Attempts per record (default 3): a free host cold-starts in ~30s. */
  attempts?: number;
  retryDelayMs?: number;
  logger?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The shape the control-plane stores. Anything else is weight on the wire. */
interface WireFinding {
  path: string;
  line: number;
  severity: string;
  category: string;
  title: string;
  source: string;
  confidence: number;
  immutable: boolean;
  agent?: string;
  verified: boolean;
}

export function toWireFinding(f: Finding): WireFinding {
  return {
    path: f.path,
    line: f.line,
    severity: f.severity,
    category: f.category,
    title: f.title,
    source: f.source,
    confidence: f.confidence,
    immutable: f.immutable === true,
    ...(f.agent ? { agent: f.agent } : {}),
    // The dashboard's headline number and the public proven-catches feed both
    // hang off this flag, so it is derived from the sandbox result, never from
    // whether verification happened to run.
    verified: f.verification?.status === "VERIFIED",
  };
}

export function makeReviewRecorder(opts: RecorderOptions): ReviewRecorder {
  const base = opts.url.replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const doSleep = opts.sleepImpl ?? sleep;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const attempts = Math.max(1, opts.attempts ?? 3);
  const delayMs = opts.retryDelayMs ?? 2000;

  return async (input: RecordReviewInput): Promise<boolean> => {
    const payload = JSON.stringify({
      org: input.org,
      repo: input.repo,
      pr: input.pr,
      title: input.title,
      ...(input.url ? { url: input.url } : {}),
      findings: input.findings.map(toWireFinding),
      ...(typeof input.costUsd === "number" ? { costUsd: input.costUsd } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(typeof input.durationMs === "number" ? { durationMs: input.durationMs } : {}),
      ...(typeof input.verifiedCount === "number" ? { verifiedCount: input.verifiedCount } : {}),
      ...(typeof input.suppressedCount === "number" ? { suppressedCount: input.suppressedCount } : {}),
      ...(input.retention ? { retention: input.retention } : {}),
    });

    let lastProblem = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const res = await doFetch(`${base}/api/reviews`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
          body: payload,
          signal: abort.signal,
        });
        if (res.ok) {
          opts.logger?.info?.("review recorded on the dashboard", {
            org: input.org,
            repo: input.repo,
            pr: input.pr,
            findings: input.findings.length,
          });
          return true;
        }
        lastProblem = `HTTP ${res.status}`;
        // 429 means the workspace is over its daily quota and 4xx generally means
        // a configuration mistake. Neither improves by asking again.
        if (res.status < 500) {
          opts.logger?.warn("review not recorded on the dashboard", {
            org: input.org,
            repo: input.repo,
            pr: input.pr,
            status: res.status,
            hint:
              res.status === 429
                ? "this workspace is over its reviews/day limit, so the dashboard will not show this one"
                : res.status === 401
                  ? "CAVIX_INTERNAL_TOKEN differs between the site and the orchestrator"
                  : "check that the control-plane is running this version of the API",
          });
          return false;
        }
      } catch (err) {
        lastProblem = abort.signal.aborted ? `timed out after ${timeoutMs}ms` : (err as Error).message;
      } finally {
        clearTimeout(timer);
      }
      if (attempt < attempts) await doSleep(delayMs * attempt);
    }

    // Never thrown: the review is already on the pull request, and the org losing
    // one dashboard row is not worth failing (and retrying) the whole job for.
    opts.logger?.warn("review not recorded on the dashboard, giving up", {
      org: input.org,
      repo: input.repo,
      pr: input.pr,
      err: lastProblem,
    });
    return false;
  };
}
