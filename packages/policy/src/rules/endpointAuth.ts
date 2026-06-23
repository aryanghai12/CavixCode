import type { PolicyContext, PolicyRule, PolicyViolation } from "../types.ts";

// Example governance rule: every HTTP endpoint handler must perform an auth
// check. This is the rule named in the Phase 1 brief. It is deliberately generic
// (an org compliance requirement), and it is cross-file aware: the auth check may
// be an imported helper — the call still appears in the handler body, and for
// named handlers defined in another file we resolve the body via the code graph.

const AUTH =
  /auth|authoriz|authenticat|require[_-]?user|require[_-]?login|login_required|jwt_required|check[_-]?auth|validate[_-]?token|verify[_-]?(?:token|jwt)|current[_-]?user|ensure[_-]?logged|is[_-]?logged|permission|access[_-]?control/i;

const EXPRESS_ROUTE =
  /\b(?:app|router|r|api|server)\.(get|post|put|patch|delete|all)\s*\(\s*(["'`])[^"'`]+\2\s*,\s*([\s\S]*)$/;
const FLASK_ROUTE = /@\s*(?:\w+)\.route\s*\(/;

export const endpointNeedsAuth: PolicyRule = {
  id: "endpoint-needs-auth",
  title: "Endpoint handler is missing an authentication check",
  severity: "high",
  category: "governance",
  evaluate(ctx: PolicyContext): PolicyViolation[] {
    const out: PolicyViolation[] = [];
    for (const file of ctx.files) {
      const lines = file.content.split("\n");
      if (/\.(js|jsx|mjs|cjs|ts|tsx)$/i.test(file.path)) {
        out.push(...evalExpress(file.path, lines, ctx));
      } else if (/\.py$/i.test(file.path)) {
        out.push(...evalFlask(file.path, lines));
      }
    }
    return out;
  },
};

function evalExpress(path: string, lines: string[], ctx: PolicyContext): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = EXPRESS_ROUTE.exec(lines[i]);
    if (!m) continue;
    const rest = m[3].trim();
    let body: string | null = null;
    if (rest.startsWith("(") || rest.startsWith("async") || rest.startsWith("function")) {
      body = extractBraceBody(lines, i); // inline handler
    } else {
      const name = /^([A-Za-z_$][\w$]*)/.exec(rest)?.[1];
      if (name) body = resolveNamedHandlerBody(name, ctx);
    }
    if (body !== null && !AUTH.test(body)) {
      out.push({ path, line: i + 1, message: routeMessage(lines[i]) });
    }
  }
  return out;
}

function evalFlask(path: string, lines: string[]): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!FLASK_ROUTE.test(lines[i])) continue;
    // The handler def is the next `def` after the (possibly stacked) decorators.
    let j = i + 1;
    while (j < lines.length && !/^\s*def\s/.test(lines[j])) j++;
    if (j >= lines.length) continue;
    const body = extractIndentBody(lines, j);
    if (!AUTH.test(lines[j] + "\n" + body)) {
      out.push({ path, line: j + 1, message: routeMessage(lines[i]) });
    }
  }
  return out;
}

// Resolve a named express handler defined anywhere in the repo (cross-file) and
// return its body text, using the code graph to find the file+line.
function resolveNamedHandlerBody(name: string, ctx: PolicyContext): string | null {
  if (!ctx.index) return null;
  const syms = ctx.index.findByName(name);
  if (syms.length === 0) return null;
  const sym = syms[0];
  const file = ctx.files.find((f) => f.path === sym.path);
  if (!file) return null;
  const lines = file.content.split("\n");
  return extractBraceBody(lines, sym.line - 1);
}

function routeMessage(routeLine: string): string {
  return `This endpoint handler does not call any authentication/authorization check. Org policy requires every endpoint to verify the caller. (route: ${routeLine.trim().slice(0, 80)})`;
}

// Extract a {...} body starting at/after line index `from`, brace-matched.
function extractBraceBody(lines: string[], from: number): string {
  let depth = 0;
  let started = false;
  const collected: string[] = [];
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    collected.push(line);
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        started = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (started && depth <= 0) break;
  }
  return collected.join("\n");
}

// Extract a Python def body by indentation (lines more indented than the def).
function extractIndentBody(lines: string[], defLine: number): string {
  const defIndent = indentOf(lines[defLine]);
  const out: string[] = [];
  for (let i = defLine + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      out.push(lines[i]);
      continue;
    }
    if (indentOf(lines[i]) <= defIndent) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

function indentOf(line: string): number {
  const m = /^(\s*)/.exec(line);
  return m ? m[1].length : 0;
}
