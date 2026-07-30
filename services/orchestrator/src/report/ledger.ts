// The per-pull-request finding ledger, as the orchestrator sees it.
//
// The control-plane stores it and this reads and writes it. The decision about
// whether a finding still stands is made HERE, in the workflow, because it is a
// question about the code: only this service holds the diff.
//
// Both halves fail soft, and they fail soft in OPPOSITE directions, which is the
// only interesting thing about this file:
//
//   fetch  cannot be reached  ->  an empty ledger. The review runs on what it
//          found this time, exactly as it did before any of this existed. A
//          control-plane outage costs the customer their carried findings for
//          one review, not their review.
//   save   cannot be reached  ->  logged and swallowed. The review is already on
//          the pull request by then. The cost is that the NEXT review re-raises
//          what this one raised, which is noise, not a wrong verdict.
//
// Neither may throw. A dashboard hiccup that failed the job would make the queue
// retry a review that has already been posted.

import { coerceLedger, EMPTY_LEDGER, type Budget, type PrLedger } from "@cavix/review-session";

export interface LedgerRef {
  org: string;
  /** "owner/repo" as the host names it: the store keys pull requests by this. */
  repo: string;
  pr: number;
}

export interface LedgerState {
  ledger: PrLedger;
  /** This pull request's review allowance, when the control-plane sent one. */
  budget?: Budget;
  /**
   * Did this come from the control-plane, or is it the empty fallback?
   *
   * The difference matters on the pull request. A review that carried nothing
   * because there was nothing to carry is not the same as one that carried
   * nothing because it could not ask, and the second must not be rendered as
   * "no open findings from earlier reviews".
   */
  known: boolean;
}

/** Read the ledger for one pull request. Never throws. */
export type LedgerFetcher = (ref: LedgerRef) => Promise<LedgerState>;

/** Persist it after the review is posted. Returns false if it did not land. */
export type LedgerSaver = (ref: LedgerRef, ledger: PrLedger) => Promise<boolean>;

export interface LedgerClientOptions {
  url: string;
  token: string;
  /** Give up rather than holding a review behind an unresponsive site. */
  timeoutMs?: number;
  logger?: {
    info?: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
  fetchImpl?: typeof fetch;
}

export interface LedgerClient {
  fetch: LedgerFetcher;
  save: LedgerSaver;
}

export function makeLedgerClient(opts: LedgerClientOptions): LedgerClient {
  const base = opts.url.replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;

  const endpoint = (ref: LedgerRef) =>
    `${base}/api/internal/orgs/${encodeURIComponent(ref.org)}/pr-ledger` +
    `?repo=${encodeURIComponent(ref.repo)}&pr=${ref.pr}`;

  return {
    async fetch(ref: LedgerRef): Promise<LedgerState> {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const res = await doFetch(endpoint(ref), {
          headers: { authorization: `Bearer ${opts.token}` },
          signal: abort.signal,
        });
        if (!res.ok) {
          opts.logger?.warn("pull request ledger: control-plane rejected the read", {
            ...ref,
            status: res.status,
            effect: "this review will not carry findings from earlier ones",
          });
          return { ledger: EMPTY_LEDGER, known: false };
        }
        const body = (await res.json()) as { ledger?: unknown; budget?: Budget };
        return {
          ledger: coerceLedger(body.ledger),
          ...(body.budget ? { budget: body.budget } : {}),
          known: true,
        };
      } catch (err) {
        opts.logger?.warn("pull request ledger: control-plane unreachable", {
          ...ref,
          err: abort.signal.aborted ? `timed out after ${timeoutMs}ms` : (err as Error).message,
          effect: "this review will not carry findings from earlier ones",
        });
        return { ledger: EMPTY_LEDGER, known: false };
      } finally {
        clearTimeout(timer);
      }
    },

    async save(ref: LedgerRef, ledger: PrLedger): Promise<boolean> {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const res = await doFetch(endpoint(ref), {
          method: "PUT",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
          body: JSON.stringify({ ledger }),
          signal: abort.signal,
        });
        if (res.ok) return true;
        opts.logger?.warn("pull request ledger: not saved", {
          ...ref,
          status: res.status,
          effect: "the next review will re-raise what this one raised",
        });
        return false;
      } catch (err) {
        opts.logger?.warn("pull request ledger: not saved", {
          ...ref,
          err: abort.signal.aborted ? `timed out after ${timeoutMs}ms` : (err as Error).message,
          effect: "the next review will re-raise what this one raised",
        });
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
