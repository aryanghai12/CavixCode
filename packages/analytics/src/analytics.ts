import type { Severity } from "@cavix/core";

// ROI analytics. One ReviewEvent per posted finding feeds an append-only store
// (ClickHouse in production; in-memory here). Per-team reports turn that into the
// numbers a sales/exec motion needs: action rate, defects caught, and
// reviewer-hours saved. The hours model is explicit and tunable — no magic.

export interface ReviewEvent {
  team: string;
  repo: string;
  reviewId: string;
  findingId: string;
  severity: Severity;
  source: string;
  agent?: string;
  /** Execution-verified (Stage 10). */
  verified: boolean;
  /** A verified fix PR was opened for this finding. */
  fixPrOpened: boolean;
  decision: "accepted" | "rejected" | "none";
  at: string;
}

export interface AnalyticsStore {
  ingest(e: ReviewEvent): void;
  events(team?: string, sinceMs?: number): ReviewEvent[];
  teams(): string[];
}

export class InMemoryAnalyticsStore implements AnalyticsStore {
  private rows: ReviewEvent[] = [];
  ingest(e: ReviewEvent): void {
    this.rows.push(e);
  }
  events(team?: string, sinceMs?: number): ReviewEvent[] {
    const cutoff = sinceMs ? Date.now() - sinceMs : 0;
    return this.rows.filter((r) => (!team || r.team === team) && (!sinceMs || Date.parse(r.at) >= cutoff));
  }
  teams(): string[] {
    return [...new Set(this.rows.map((r) => r.team))];
  }
}

// The hours model: how long a human reviewer would have spent finding +
// confirming an issue of each severity, how much an authored+verified fix saves,
// and the small overhead a false positive costs. All tunable per org.
export interface RoiRates {
  minutesPerSeverity: Record<Severity, number>;
  fixAuthoringMinutes: number;
  rejectedOverheadMinutes: number;
}

export const DEFAULT_RATES: RoiRates = {
  minutesPerSeverity: { critical: 60, high: 40, medium: 20, low: 8, info: 3 },
  fixAuthoringMinutes: 30,
  rejectedOverheadMinutes: 3,
};

export interface TeamReport {
  team: string;
  totalFindings: number;
  actedOn: number;
  actionRate: number; // actedOn / total
  defectsCaught: number; // verified findings (proven real)
  falsePositives: number; // rejected
  fixPrsOpened: number;
  reviewerHoursSaved: number;
  bySeverity: Record<string, number>;
}

export function computeTeamReport(events: ReviewEvent[], rates: RoiRates = DEFAULT_RATES): TeamReport {
  const team = events[0]?.team ?? "";
  let actedOn = 0;
  let defects = 0;
  let rejected = 0;
  let fixPrs = 0;
  let savedMinutes = 0;
  const bySeverity: Record<string, number> = {};

  for (const e of events) {
    bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
    const acted = e.decision === "accepted" || e.fixPrOpened;
    if (acted) actedOn++;
    if (e.verified) defects++;
    if (e.decision === "rejected") rejected++;
    if (e.fixPrOpened) fixPrs++;

    // Hours saved: a human would have spent find+confirm time on issues that were
    // accepted (real, actioned). Verified findings count even at "none" decision
    // because the proof itself replaces manual triage.
    if (e.decision === "accepted" || e.verified) savedMinutes += rates.minutesPerSeverity[e.severity];
    if (e.fixPrOpened) savedMinutes += rates.fixAuthoringMinutes;
    if (e.decision === "rejected") savedMinutes -= rates.rejectedOverheadMinutes;
  }

  return {
    team,
    totalFindings: events.length,
    actedOn,
    actionRate: events.length ? round(actedOn / events.length) : 0,
    defectsCaught: defects,
    falsePositives: rejected,
    fixPrsOpened: fixPrs,
    reviewerHoursSaved: round(Math.max(0, savedMinutes) / 60),
    bySeverity,
  };
}

export interface OrgRollup {
  teams: TeamReport[];
  totalFindings: number;
  actionRate: number;
  defectsCaught: number;
  reviewerHoursSaved: number;
}

export function computeOrgRollup(store: AnalyticsStore, rates: RoiRates = DEFAULT_RATES): OrgRollup {
  const teams = store.teams().map((t) => computeTeamReport(store.events(t), rates));
  const totalFindings = sum(teams, (t) => t.totalFindings);
  const actedOn = sum(teams, (t) => t.actedOn);
  return {
    teams,
    totalFindings,
    actionRate: totalFindings ? round(actedOn / totalFindings) : 0,
    defectsCaught: sum(teams, (t) => t.defectsCaught),
    reviewerHoursSaved: round(sum(teams, (t) => t.reviewerHoursSaved)),
  };
}

function sum<T>(arr: T[], f: (t: T) => number): number {
  return arr.reduce((n, t) => n + f(t), 0);
}
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
