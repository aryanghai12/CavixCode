import type { Finding } from "@cavix/core";

// Stage 12 — learning loop. Train a lightweight calibration on the org's
// accept/reject decisions (from the dashboard) and feed it back into:
//   - Stage 9: per-category confidence thresholds (raise where the org rejects a
//     lot → fewer false positives; lower where it accepts).
//   - Stage 10: the verify gate (verify MORE where acceptance is mixed — that's
//     where proof adds the most value — and less where the answer is already
//     obvious from history).
// "Lightweight" = smoothed empirical accept rates, not a heavyweight model. It is
// per-org, interpretable, and updates as decisions accumulate.

export interface DecisionRecord {
  category: string;
  agent?: string;
  source: string;
  confidence: number;
  accepted: boolean;
}

export interface OrgCalibration {
  categoryAcceptRate: Record<string, number>;
  agentAcceptRate: Record<string, number>;
  thresholdByCategory: Record<string, number>;
  verifyGateByCategory: Record<string, number>;
  sampleCount: number;
}

export interface CalibrateOptions {
  baseThreshold?: number;
  baseVerifyGate?: number;
  /** How strongly accept-rate moves the threshold. */
  thresholdScale?: number;
  /** Laplace smoothing strength. */
  alpha?: number;
}

const DEFAULTS = { baseThreshold: 0.5, baseVerifyGate: 0.5, thresholdScale: 0.6, alpha: 1 };

export function calibrate(decisions: DecisionRecord[], options: CalibrateOptions = {}): OrgCalibration {
  const o = { ...DEFAULTS, ...options };
  const byCat = groupRate(decisions, (d) => d.category, o.alpha);
  const byAgent = groupRate(decisions.filter((d) => d.agent), (d) => d.agent!, o.alpha);

  const thresholdByCategory: Record<string, number> = {};
  const verifyGateByCategory: Record<string, number> = {};
  for (const [cat, rate] of Object.entries(byCat)) {
    // Low acceptance → raise the bar; high acceptance → relax it.
    thresholdByCategory[cat] = clamp(o.baseThreshold + (0.5 - rate) * o.thresholdScale, 0.2, 0.9);
    // Mixed (rate≈0.5) → verify more (gate near base); extreme → verify less.
    verifyGateByCategory[cat] = clamp(o.baseVerifyGate + Math.abs(rate - 0.5) * o.thresholdScale, 0.2, 0.95);
  }

  return { categoryAcceptRate: byCat, agentAcceptRate: byAgent, thresholdByCategory, verifyGateByCategory, sampleCount: decisions.length };
}

export class Calibration {
  private readonly data: OrgCalibration;
  private readonly base: number;
  constructor(data: OrgCalibration, baseThreshold = 0.5) {
    this.data = data;
    this.base = baseThreshold;
  }

  thresholdFor(category: string): number {
    return this.data.thresholdByCategory[category] ?? this.base;
  }
  verifyGateFor(category: string): number {
    return this.data.verifyGateByCategory[category] ?? 0.5;
  }

  // Reliability-weighted confidence: down-weight findings from agents/categories
  // the org tends to reject, up-weight trusted ones.
  calibratedConfidence(f: Finding): number {
    const rate = (f.agent ? this.data.agentAcceptRate[f.agent] : undefined) ?? this.data.categoryAcceptRate[f.category];
    if (rate === undefined) return f.confidence;
    return clamp(f.confidence * (0.5 + rate), 0, 0.99);
  }

  // Apply learned per-category thresholds to LLM findings (facts always pass).
  filterFindings(findings: Finding[]): { kept: Finding[]; dropped: Array<{ finding: Finding; reason: string }> } {
    const kept: Finding[] = [];
    const dropped: Array<{ finding: Finding; reason: string }> = [];
    for (const f of findings) {
      if (f.immutable || f.source !== "llm") {
        kept.push(f);
        continue;
      }
      const cal = this.calibratedConfidence(f);
      const thr = this.thresholdFor(f.category);
      if (cal >= thr) kept.push(f);
      else dropped.push({ finding: f, reason: `learned threshold for "${f.category}" is ${thr.toFixed(2)}; calibrated confidence ${cal.toFixed(2)}` });
    }
    return { kept, dropped };
  }
}

function groupRate<T>(items: T[], key: (t: T) => string, alpha: number): Record<string, number> {
  const acc = new Map<string, { yes: number; n: number }>();
  for (const it of items as Array<{ accepted: boolean }>) {
    const k = key(it as unknown as T);
    if (!acc.has(k)) acc.set(k, { yes: 0, n: 0 });
    const e = acc.get(k)!;
    e.n++;
    if (it.accepted) e.yes++;
  }
  const out: Record<string, number> = {};
  for (const [k, { yes, n }] of acc) out[k] = (yes + alpha) / (n + 2 * alpha); // Laplace-smoothed
  return out;
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
