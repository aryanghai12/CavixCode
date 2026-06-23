import type { Finding, Severity } from "@cavix/core";

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
  return { summary, findings };
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
