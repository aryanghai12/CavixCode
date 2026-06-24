import type { Evidence, Finding, Severity } from "@cavix/core";
import type { AgentSpec } from "./types.ts";

const VALID_SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);

export interface ParsedAgentReply {
  abstained: boolean;
  findings: Finding[];
}

// Parse one agent's JSON reply into findings tagged with the agent + evidence.
// A malformed reply abstains (safer than throwing inside a parallel ensemble).
export function parseAgentReply(text: string, spec: AgentSpec): ParsedAgentReply {
  const json = extractJsonObject(text);
  if (!json) return { abstained: true, findings: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { abstained: true, findings: [] };
  }
  if (typeof raw !== "object" || raw === null) return { abstained: true, findings: [] };
  const obj = raw as Record<string, unknown>;
  const findingsRaw = Array.isArray(obj.findings) ? obj.findings : [];
  const findings: Finding[] = [];
  for (const f of findingsRaw) {
    const parsed = coerce(f, spec);
    if (parsed) findings.push(parsed);
  }
  const abstained = obj.abstain === true || findings.length === 0;
  return { abstained, findings };
}

function coerce(value: unknown, spec: AgentSpec): Finding | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const path = typeof v.path === "string" ? v.path : "";
  const line = typeof v.line === "number" ? Math.trunc(v.line) : NaN;
  const title = typeof v.title === "string" ? v.title : "";
  if (!path || !Number.isFinite(line) || line < 1 || !title) return null;
  const severity: Severity = VALID_SEVERITIES.has(String(v.severity)) ? (v.severity as Severity) : "info";
  return {
    path,
    line,
    severity,
    category: typeof v.category === "string" ? v.category : spec.category,
    title,
    body: typeof v.body === "string" ? v.body : "",
    suggestion: typeof v.suggestion === "string" ? v.suggestion : undefined,
    source: "llm",
    agent: spec.id,
    confidence: typeof v.confidence === "number" ? clamp01(v.confidence) : 0.5,
    evidence: coerceEvidence(v.evidence),
  };
}

function coerceEvidence(value: unknown): Evidence[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Evidence[] = [];
  for (const e of value) {
    if (typeof e !== "object" || e === null) continue;
    const ev = e as Record<string, unknown>;
    if (typeof ev.path !== "string") continue;
    out.push({
      path: ev.path,
      line: typeof ev.line === "number" ? Math.trunc(ev.line) : undefined,
      note: typeof ev.note === "string" ? ev.note : undefined,
      snippet: typeof ev.snippet === "string" ? ev.snippet : undefined,
    });
  }
  return out.length ? out : undefined;
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

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
