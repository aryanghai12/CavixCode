import type { CodeIndex } from "./indexer.ts";
import type { SymbolNode } from "./graph.ts";

// The call path a change sits on, in the order the calls are written.
//
// This is the data behind the review's sequence diagram, and the reason it is
// here rather than next to the renderer: it is a QUERY over Stage 4's graph, not
// prose. Every participant is a file the index parsed and every message is a
// call it resolved. Nothing in the output was written by a model, which is the
// only reason a diagram is worth putting on a pull request at all: a drawing of
// a flow that was inferred from a diff is a guess with arrows on it, and the
// reader has no way to tell one from the other.
//
// What it deliberately is NOT:
//   - a diagram of the whole file, or of every symbol in the change. That is a
//     picture of the codebase, not of the change.
//   - a diagram of a single file's internals. A sequence diagram earns its space
//     by showing a boundary being crossed; with one lifeline it is a list, and a
//     list is what the walkthrough already is.
//   - complete. It is capped, and it says so when it was cut.
//
// THE REACH IS THE INDEX'S REACH, and that is worth being explicit about because
// it decides what the picture means. In the live path Stage 4 indexes the files
// this pull request changed and nothing else, so a call into a file the diff
// does not touch has no symbol to resolve against and is not drawn, even when
// the import sits right there at the top of the file. That is the correct
// behaviour and not a gap to paper over: an arrow inferred from an import
// statement is a guess, and a diagram that mixes measured arrows with guessed
// ones is worth less than no diagram, because the reader cannot tell which is
// which. So this draws how the changed files now call EACH OTHER.

export interface CallStep {
  fromPath: string;
  fromSymbol: string;
  toPath: string;
  toSymbol: string;
  /** 1-based line of the call site, in the caller's file. */
  line: number;
}

export interface CallTrace {
  /** File paths, in the order the trace first reaches them. */
  participants: string[];
  steps: CallStep[];
  /** Names of the changed symbols the trace starts from. */
  entryPoints: string[];
  /** True when the graph had more to give and the caps stopped it. */
  truncated: boolean;
}

export interface TraceOptions {
  /** Lifelines. More than a handful and the diagram is wider than it is useful. */
  maxParticipants?: number;
  /** Arrows. A reader stops following a sequence long before this. */
  maxSteps?: number;
  /** How far to follow the calls out from a changed symbol. */
  maxDepth?: number;
  /**
   * Arrows below which there is no sequence worth drawing. One interaction is a
   * sentence, and the walkthrough is already made of those.
   */
  minSteps?: number;
}

const DEFAULTS = { maxParticipants: 6, maxSteps: 14, maxDepth: 4, minSteps: 2 };

/**
 * Trace the call path through the symbols this diff changed.
 *
 * Returns null when there is nothing honest to draw, which is the common case
 * and not a failure: most pull requests change one file, and a sequence diagram
 * of one file is a list with extra steps. The caller renders nothing at all
 * rather than an empty diagram, because an empty diagram reads as a broken
 * feature and an absent section reads as "not relevant here", which is the truth.
 */
export function traceSequence(index: CodeIndex, diff: string, options: TraceOptions = {}): CallTrace | null {
  const o = {
    maxParticipants: options.maxParticipants ?? DEFAULTS.maxParticipants,
    maxSteps: options.maxSteps ?? DEFAULTS.maxSteps,
    maxDepth: options.maxDepth ?? DEFAULTS.maxDepth,
    minSteps: options.minSteps ?? DEFAULTS.minSteps,
  };

  const changed = index.blastRadiusFromDiff(diff).changed;
  if (changed.length === 0) return null;
  const changedIds = new Set(changed.map((s) => s.id));

  // Start where the flow starts.
  //
  // Sorting changed symbols by path alone put whichever file sorts first at the
  // top, so a change to `refund.js` and `webhook.js` drew the refund path as the
  // opening lifeline and the webhook that calls it as a reply, which reads
  // backwards. A changed symbol that nothing else in the change calls is a root
  // of this flow, so roots lead. Path and line break the tie, because two runs
  // over the same pull request must produce the same diagram or a re-review
  // rewrites the description for no reason.
  const isRoot = (s: SymbolNode) => !index.callersOf(s.id).some((c) => changedIds.has(c.id) && c.id !== s.id);
  const entries = [...changed].sort(
    (a, b) =>
      Number(isRoot(b)) - Number(isRoot(a)) || a.path.localeCompare(b.path) || a.line - b.line,
  );

  const participants: string[] = [];
  const steps: CallStep[] = [];
  const walked = new Set<string>();
  let truncated = false;

  /** Claim a lifeline for a file, or refuse when the diagram is already full. */
  const admit = (path: string): boolean => {
    if (participants.includes(path)) return true;
    if (participants.length >= o.maxParticipants) {
      truncated = true;
      return false;
    }
    participants.push(path);
    return true;
  };

  // Depth-first in call-site order, which is the order the code runs in closely
  // enough to read as a story: a caller, then what its first call reaches, then
  // its second. Breadth-first would group by distance from the change, which is
  // a fact about the graph and not about the flow.
  //
  // ONLY CALLS THAT CROSS A FILE ARE DRAWN, and this is the difference between a
  // diagram worth the space and one nobody reads. A realistic handler calls a
  // dozen local helpers before it calls anything else, and drawing each of them
  // as a self-message filled the step budget with `handler.ts ->> handler.ts`
  // rows and pushed the one interaction that mattered off the bottom. Past about
  // fifteen helpers it pushed EVERY cross-file call out, leaving one lifeline
  // and therefore no diagram at all, on exactly the changes most deserving of
  // one. Local calls are still walked THROUGH, so a helper that reaches another
  // file is drawn from the file its call site is written in, which is the true
  // fact at this granularity.
  const walk = (from: SymbolNode, depth: number): void => {
    if (depth >= o.maxDepth || walked.has(from.id)) return;
    walked.add(from.id);

    for (const { symbol: to, line } of index.callSitesFrom(from.id)) {
      if (steps.length >= o.maxSteps) {
        truncated = true;
        return;
      }
      if (to.path === from.path) {
        walk(to, depth + 1);
        continue;
      }
      // Both ends need a lifeline. Admitting one and not the other would draw an
      // arrow from nowhere.
      if (!participants.includes(from.path) && !admit(from.path)) return;
      if (!admit(to.path)) continue;

      steps.push({ fromPath: from.path, fromSymbol: from.name, toPath: to.path, toSymbol: to.name, line });
      walk(to, depth + 1);
    }
  };

  for (const entry of entries) {
    if (steps.length >= o.maxSteps) {
      truncated = true;
      break;
    }
    walk(entry, 0);
  }

  // Fewer than two interactions is not a sequence, and one lifeline is a list.
  // Either way say so by returning null rather than by returning an object the
  // caller has to know to distrust.
  if (steps.length < o.minSteps || participants.length < 2) return null;

  return {
    participants,
    steps,
    // Only the changed symbols the drawn steps actually start from. A changed
    // symbol whose calls were all local, or all cut by the caps, did not
    // contribute a lifeline and naming it in the caption would misdescribe the
    // picture underneath.
    entryPoints: entries
      .filter((e) => changedIds.has(e.id) && steps.some((s) => s.fromSymbol === e.name && s.fromPath === e.path))
      .map((e) => e.name),
    truncated,
  };
}
