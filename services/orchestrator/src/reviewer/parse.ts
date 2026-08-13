import type { FileChange, Finding, Severity } from "@cavix/core";

// Parsing the model's reply into structured findings. LLMs occasionally wrap JSON
// in prose or code fences, so we extract the first balanced JSON object before
// parsing. Individual malformed findings are dropped (not fatal) so one bad entry
// can't sink an otherwise good review; a totally unparseable reply throws so the
// workflow can record it as a failure rather than silently posting nothing.

const VALID_SEVERITIES: ReadonlySet<string> = new Set([
  "critical",
  "high",
  "medium",
  "low",
  "info",
]);

export interface ParsedReview {
  summary: string;
  /** Per-file walkthrough; empty when the model omitted or mangled it. */
  walkthrough: FileChange[];
  /** Review-effort estimate 1..5; undefined when the model gave none. */
  effort?: number;
  findings: Finding[];
}

export function parseModelReview(text: string): ParsedReview {
  const json = extractJsonObject(text);
  if (json === null) {
    throw new Error("model reply contained no JSON object");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`model reply was not valid JSON: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error("model reply JSON was not an object");
  }
  const obj = raw as Record<string, unknown>;
  const summary = typeof obj.summary === "string" ? obj.summary : "";
  const findingsRaw = Array.isArray(obj.findings) ? obj.findings : [];

  const findings: Finding[] = [];
  for (const f of findingsRaw) {
    const parsed = coerceFinding(f);
    if (parsed) findings.push(parsed);
  }

  // The walkthrough and effort are presentation, never load-bearing: a model that
  // skips them (or returns junk) still produces a perfectly valid review, and the
  // poster falls back to what it can derive from the diff itself.
  const walkthrough: FileChange[] = [];
  if (Array.isArray(obj.walkthrough)) {
    for (const w of obj.walkthrough) {
      const parsed = coerceFileChange(w);
      if (parsed) walkthrough.push(parsed);
    }
  }

  // A refusal is not a clean review.
  //
  // This is the single most dangerous thing this parser can get wrong. A model
  // that answers "I cannot review this pull request, please ask a specific
  // question" inside a well-formed JSON object used to sail straight through:
  // zero findings is a valid review, so Cavix posted "Clean pass. Nothing to
  // raise", stamped a green check on the pull request, and spliced the refusal
  // itself into the description as the executive summary. The reader sees a
  // reviewed, passing pull request. Nothing read a line of it.
  //
  // Throwing puts it on the failure path instead, which posts a neutral check
  // and a comment naming the cause, and the check stays neutral rather than
  // green so nothing is gated on a review that never happened.
  if (isRefusal(summary, findings.length, walkthrough.length)) {
    throw new Error(`the model declined to review this change: ${summary.trim().slice(0, 300)}`);
  }

  return { summary, walkthrough, effort: coerceEffort(obj.effort), findings };
}

/**
 * Phrases a model uses when it is declining rather than reviewing.
 *
 * Anchored near the start, because a legitimate summary can easily contain
 * "cannot" in the middle of a sentence ("Callers cannot retry safely").
 */
const REFUSAL_OPENERS =
  /^\s*(?:sorry[,.]?\s*)?(?:but\s+)?(?:i|as an ai|unfortunately|it (?:is|'s) not possible)\b[^.!?]{0,80}?\b(?:cannot|can(?:'|’)?t|am unable|unable|won(?:'|’)?t be able|do not have|don(?:'|’)?t have)\b/i;

/** A direct instruction back at the user, which a review never contains. */
const ASKS_FOR_INPUT =
  /\b(?:please (?:ask|provide|specify|clarify|share)|ask a specific question|provide (?:more|the) (?:context|information|details)|specify (?:a|the) question)\b/i;

/**
 * Does this reply decline to do the job?
 *
 * Deliberately conservative: it requires the model to have produced NOTHING
 * usable, so a real review that happens to be phrased oddly is never discarded.
 * The prompt demands a walkthrough entry for every file in the diff, so a reply
 * with no findings AND no walkthrough has not reviewed anything, whatever it
 * says. Both signals must line up before this fires.
 */
export function isRefusal(summary: string, findingCount: number, walkthroughCount: number): boolean {
  if (findingCount > 0 || walkthroughCount > 0) return false;
  const text = summary.trim();
  // An empty summary with nothing else is a different failure (an empty diff, a
  // model that returned a bare skeleton) and is not this one.
  if (text === "") return false;
  return REFUSAL_OPENERS.test(text) || ASKS_FOR_INPUT.test(text);
}

function coerceFileChange(value: unknown): FileChange | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const path = typeof v.path === "string" ? v.path.trim() : "";
  const summary = typeof v.summary === "string" ? v.summary.trim() : "";
  if (!path || !summary) return null;
  return { path, summary };
}

/** Effort is a 1..5 dial; anything else is discarded rather than guessed at. */
function coerceEffort(value: unknown): number | undefined {
  const n = typeof value === "number" ? Math.round(value) : NaN;
  if (!Number.isFinite(n) || n < 1 || n > 5) return undefined;
  return n;
}

function coerceFinding(value: unknown): Finding | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;

  const path = typeof v.path === "string" ? v.path : "";
  const line = typeof v.line === "number" ? Math.trunc(v.line) : NaN;
  const title = typeof v.title === "string" ? v.title : "";
  if (!path || !Number.isFinite(line) || line < 1 || !title) return null;

  const severity: Severity = VALID_SEVERITIES.has(String(v.severity))
    ? (v.severity as Severity)
    : "info";
  const confidence =
    typeof v.confidence === "number" ? clamp01(v.confidence) : 0.5;

  return {
    path,
    line,
    endLine: typeof v.endLine === "number" ? Math.trunc(v.endLine) : undefined,
    severity,
    category: typeof v.category === "string" ? v.category : "other",
    title,
    body: typeof v.body === "string" ? v.body : "",
    suggestion: typeof v.suggestion === "string" ? v.suggestion : undefined,
    source: "llm",
    confidence,
  };
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * extractJsonObject returns the first top-level {...} block in text, scanning
 * with brace-depth tracking while ignoring braces inside strings. This survives
 * the model adding "Here is the review:" preamble or ```json fences.
 */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
