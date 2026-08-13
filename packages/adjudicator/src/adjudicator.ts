import { SEVERITY_RANK, type Evidence, type Finding, type Severity } from "@cavix/core";

// Stage 9 — adjudication. Inputs: every finding from the agent ensemble (llm),
// the deterministic stage (secret/sast/linter), and the optional policy gate
// (immutable). Job: dedupe overlapping findings, let agreement raise confidence,
// threshold the uncertain LLM ones, and decide what gets posted.
//
// THE INVARIANTS (this is where "the LLM cannot silently drop" lives):
//   1. immutable findings (enabled policy gate) pass through UNTOUCHED and always
//      survive — never merged, never thresholded, never dropped.
//   2. deterministic findings (secret/sast/linter) are facts: they survive
//      regardless of confidence (they may absorb overlapping LLM findings).
//   3. only pure-LLM clusters are subject to the confidence threshold.
//   4. an LLM finding the critic could not support is dropped BEFORE clustering,
//      whatever its confidence and whatever agreed with it.
// With the gate OFF there are no immutable findings, so nothing is force-passed.
//
// Invariant 4 is the one that needs defending, because it overrules the
// agreement mechanism a few lines down. `mergeCluster` treats independent
// agreement as confirmation and raises confidence for it. For models of one
// family reading one context that independence is largely fictional: they agree
// on the same hallucination, and the agreement bonus then pushes an invented
// finding straight past the threshold. Agreement is evidence about the models.
// It is not evidence about the code. The critic's checks are, so they outrank it.

export interface AdjudicationOptions {
  confidenceThreshold?: number;
  /**
   * Stage 12's learned bar, per category, for THIS workspace.
   *
   * A category that is absent falls back to `confidenceThreshold`, and that
   * distinction is deliberate: an absent entry means "this team has taught us
   * nothing about this category", which is not the same claim as "this team's
   * bar happens to equal the default". Only categories whose bar actually moved
   * appear here, so the reason string below can always name a measurement.
   */
  thresholdByCategory?: Record<string, number>;
  lineTolerance?: number;
  /**
   * The critic's answer for one finding: a reason string when it could not be
   * supported, and undefined when it could.
   *
   * Applied only to `source === "llm"` findings that are not immutable, so a
   * tool's fact is never overruled by an inference about it. Absent means no
   * critic ran, and no critic is not a failed critic: nothing is dropped.
   */
  unsupported?: (finding: Finding) => string | undefined;
}

export interface DroppedFinding {
  finding: Finding;
  reason: string;
}

export interface AdjudicationResult {
  findings: Finding[];
  dropped: DroppedFinding[];
  clusters: number;
  immutableKept: number;
  votesByFinding: Array<{ title: string; path: string; line: number; votes: number; confidence: number }>;
}

const DEFAULTS = { confidenceThreshold: 0.5, lineTolerance: 2 };
const DETERMINISTIC: ReadonlySet<Finding["source"]> = new Set(["secret", "sast", "linter", "telemetry"]);

export function adjudicate(findings: Finding[], options: AdjudicationOptions = {}): AdjudicationResult {
  // Use ?? per-field: spreading {...options} would let an explicit `undefined`
  // (e.g. an unset deps.confidenceThreshold) clobber the default with undefined.
  const opts = {
    confidenceThreshold: options.confidenceThreshold ?? DEFAULTS.confidenceThreshold,
    thresholdByCategory: options.thresholdByCategory ?? {},
    lineTolerance: options.lineTolerance ?? DEFAULTS.lineTolerance,
  };

  // (1) Immutable policy findings bypass everything.
  const immutable = findings.filter((f) => f.immutable);
  const rest = findings.filter((f) => !f.immutable);

  const kept: Finding[] = [];
  const dropped: DroppedFinding[] = [];
  const votes: AdjudicationResult["votesByFinding"] = [];

  // (4) The critic's screen, applied BEFORE clustering so that two agents
  // reporting the same phantom cannot vote it into existence between them.
  const survivors: Finding[] = [];
  for (const f of rest) {
    const objection = f.source === "llm" ? options.unsupported?.(f) : undefined;
    if (objection) dropped.push({ finding: f, reason: objection });
    else survivors.push(f);
  }

  // Cluster the remaining findings by location + topical similarity.
  const clusters = clusterFindings(survivors, opts.lineTolerance);

  for (const cluster of clusters) {
    const sources = new Set(cluster.map((f) => f.agent ?? f.source));
    const voteCount = sources.size;
    const isDeterministic = cluster.some((f) => DETERMINISTIC.has(f.source));
    const merged = mergeCluster(cluster, voteCount);

    votes.push({ title: merged.title, path: merged.path, line: merged.line, votes: voteCount, confidence: merged.confidence });

    // (2)/(3) deterministic always survives; LLM-only must clear the threshold.
    // The bar is this workspace's learned one for the category when Stage 12 has
    // measured one, and the org-wide default otherwise.
    const learned = opts.thresholdByCategory[merged.category];
    const threshold = typeof learned === "number" ? learned : opts.confidenceThreshold;
    if (isDeterministic || merged.confidence >= threshold) {
      kept.push(merged);
    } else {
      dropped.push({
        finding: merged,
        reason:
          typeof learned === "number"
            ? `below this workspace's learned "${merged.category}" threshold (${merged.confidence.toFixed(2)} < ${threshold})`
            : `below confidence threshold (${merged.confidence.toFixed(2)} < ${threshold})`,
      });
    }
  }

  // Immutable findings first (highest authority), then by severity.
  const ordered = [...immutable, ...kept].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  return {
    findings: ordered,
    dropped,
    clusters: clusters.length,
    immutableKept: immutable.length,
    votesByFinding: votes,
  };
}

// Greedy clustering: a finding joins a cluster if it shares the file, sits within
// the line tolerance, and is topically similar (same category or overlapping
// title tokens). Otherwise it starts a new cluster.
function clusterFindings(findings: Finding[], tol: number): Finding[][] {
  const clusters: Finding[][] = [];
  for (const f of findings) {
    let placed = false;
    for (const c of clusters) {
      const head = c[0];
      if (head.path === f.path && Math.abs(head.line - f.line) <= tol && topicallySimilar(head, f)) {
        c.push(f);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([f]);
  }
  return clusters;
}

function topicallySimilar(a: Finding, b: Finding): boolean {
  if (a.category === b.category) return true;
  return jaccard(tokens(a.title), tokens(b.title)) >= 0.34;
}

// Merge a cluster into one finding: max severity, agreement-boosted confidence,
// union of evidence, deterministic representative preferred.
function mergeCluster(cluster: Finding[], votes: number): Finding {
  const rep = [...cluster].sort((a, b) => rank(b) - rank(a))[0];
  const severity = cluster.reduce<Severity>((s, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[s] ? f.severity : s), "info");

  // Probabilistic OR of agent confidences — independent agreement raises it.
  const llm = cluster.filter((f) => f.source === "llm");
  const combined = llm.length > 0 ? 1 - llm.reduce((p, f) => p * (1 - f.confidence), 1) : rep.confidence;
  const confidence = Math.min(0.99, Math.max(rep.confidence, combined));

  const evidence = dedupeEvidence(cluster.flatMap((f) => f.evidence ?? []));
  const agents = [...new Set(cluster.map((f) => f.agent).filter(Boolean))] as string[];

  return {
    ...rep,
    severity,
    confidence,
    evidence: evidence.length ? evidence : rep.evidence,
    body: votes > 1 ? `${rep.body}\n\n_Corroborated by ${votes} reviewers (${agents.join(", ") || "multiple"})._` : rep.body,
  };
}

// Deterministic facts outrank LLM; then higher severity; then higher confidence.
function rank(f: Finding): number {
  const det = DETERMINISTIC.has(f.source) ? 1000 : 0;
  return det + SEVERITY_RANK[f.severity] * 10 + f.confidence;
}

function dedupeEvidence(ev: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const e of ev) {
    const key = `${e.path}:${e.line ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function tokens(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
