import type { Finding, Severity } from "@cavix/core";
import { detectLegacyLanguage, parseLegacy, type LegacyLanguage, type LegacySymbol } from "./parsers.ts";

// Legacy-specific SAST rules. Each produces a LOCATED finding (path+line) and, via
// the parsed symbols, names the enclosing paragraph/procedure/function so the
// review reads like a human reviewer who knows the codebase.

interface LineRule {
  id: string;
  title: string;
  severity: Severity;
  category: string;
  re: RegExp;
  body: string;
}

const RULES: Partial<Record<LegacyLanguage, LineRule[]>> = {
  cobol: [
    { id: "cobol/goto", title: "GO TO creates unstructured control flow", category: "maintainability", severity: "low", re: /\bGO\s+TO\b/i, body: "GO TO leads to spaghetti flow; prefer PERFORM of a paragraph." },
    { id: "cobol/alter", title: "ALTER statement is dangerous and obscure", category: "maintainability", severity: "medium", re: /\bALTER\b\s+[A-Z0-9-]+\s+TO/i, body: "ALTER mutates GO TO targets at runtime — extremely hard to follow. Refactor." },
    { id: "cobol/compute-no-size-error", title: "COMPUTE without ON SIZE ERROR", category: "correctness", severity: "medium", re: /\bCOMPUTE\b(?:(?!ON SIZE ERROR).)*$/i, body: "Arithmetic without ON SIZE ERROR can silently truncate/overflow." },
  ],
  plsql: [
    { id: "plsql/dynamic-sql-concat", title: "SQL injection via concatenated dynamic SQL", category: "security", severity: "critical", re: /EXECUTE\s+IMMEDIATE\b[^;]*\|\|/i, body: "Dynamic SQL built with || and user input — SQL injection. Use bind variables (USING)." },
    { id: "plsql/when-others-null", title: "Exception swallowed by WHEN OTHERS THEN NULL", category: "reliability", severity: "high", re: /WHEN\s+OTHERS\s+THEN\s+NULL/i, body: "WHEN OTHERS THEN NULL hides every error. Log and re-raise, or handle specifically." },
    { id: "plsql/commit-in-loop", title: "COMMIT inside a loop", category: "reliability", severity: "medium", re: /^\s*COMMIT\s*;/i, body: "Frequent COMMITs (esp. in loops) break atomicity and hurt performance." },
  ],
  cpp: [
    { id: "cpp/unsafe-string", title: "Unbounded string function (buffer overflow risk)", category: "security", severity: "high", re: /\b(?:strcpy|strcat|gets|sprintf|scanf)\s*\(/, body: "Unbounded copy can overflow the destination. Use strncpy/strncat/snprintf and validate lengths." },
    { id: "cpp/system", title: "system() invocation", category: "security", severity: "high", re: /\bsystem\s*\(/, body: "system() with any dynamic input is command injection. Use execve with an argument vector." },
    { id: "cpp/malloc-unchecked", title: "Allocation result not checked for NULL", category: "reliability", severity: "low", re: /=\s*malloc\s*\(/, body: "Check the malloc/calloc result for NULL before use." },
  ],
  java: [
    { id: "java/runtime-exec", title: "Runtime.exec with dynamic input", category: "security", severity: "high", re: /Runtime\.getRuntime\(\)\.exec\s*\(/, body: "Runtime.exec with concatenated input risks command injection. Use ProcessBuilder with an argument list." },
    { id: "java/sql-concat", title: "SQL built by string concatenation", category: "security", severity: "high", re: /execute(?:Query|Update)?\s*\([^)]*\+/, body: "Concatenated SQL — use a PreparedStatement with parameters." },
  ],
  csharp: [
    { id: "csharp/sql-concat", title: "SqlCommand built by concatenation", category: "security", severity: "high", re: /new\s+SqlCommand\s*\([^)]*\+/, body: "Concatenated SQL — use parameterized SqlCommand (cmd.Parameters)." },
  ],
  terraform: [
    { id: "tf/open-ingress", title: "Security group open to the world", category: "security", severity: "high", re: /0\.0\.0\.0\/0/, body: "0.0.0.0/0 exposes the resource to the entire internet. Restrict the CIDR." },
    { id: "tf/public-bucket", title: "Publicly readable storage", category: "security", severity: "high", re: /acl\s*=\s*"public-read"/, body: "public-read ACL exposes objects. Use private + signed URLs." },
  ],
  yaml: [
    { id: "yaml/privileged", title: "Privileged container", category: "security", severity: "high", re: /privileged:\s*true/, body: "privileged: true grants host-level access. Drop it and use least-privilege capabilities." },
  ],
};

export function legacyRuleFindings(path: string, content: string, symbols: LegacySymbol[]): Finding[] {
  const lang = detectLegacyLanguage(path);
  const rules = RULES[lang];
  if (!rules) return [];
  const lines = content.split("\n");
  const out: Finding[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const rule of rules) {
      if (rule.re.test(lines[i])) {
        const enclosing = enclosingSymbol(symbols, i + 1);
        out.push({
          path,
          line: i + 1,
          severity: rule.severity,
          category: rule.category,
          title: rule.title,
          body: enclosing ? `${rule.body} (in ${enclosing.kind} ${enclosing.name})` : rule.body,
          source: "sast",
          ruleId: rule.id,
          confidence: 0.85,
        });
      }
    }
  }
  return out;
}

function enclosingSymbol(symbols: LegacySymbol[], line: number): LegacySymbol | null {
  let best: LegacySymbol | null = null;
  for (const s of symbols) if (s.line <= line && (!best || s.line > best.line)) best = s;
  return best;
}

export interface LegacyAnalysis {
  symbols: LegacySymbol[];
  findings: Finding[];
}

/** Parse + scan a set of legacy files → located symbols and findings. */
export function analyzeLegacy(files: Array<{ path: string; content: string }>): LegacyAnalysis {
  const symbols: LegacySymbol[] = [];
  const findings: Finding[] = [];
  for (const f of files) {
    const syms = parseLegacy(f.path, f.content);
    symbols.push(...syms);
    findings.push(...legacyRuleFindings(f.path, f.content, syms));
  }
  return { symbols, findings };
}
