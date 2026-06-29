import type { Severity } from "@cavix/core";
import type { PolicyContext, PolicyRule, PolicyViolation } from "./types.ts";
import { endpointNeedsAuth } from "./rules/endpointAuth.ts";

// Compile a plain-English org rule into a DETERMINISTIC PolicyRule the engine can
// enforce. This is the optional Stage-3c gate "graduating": an admin writes
// "disallow console.log in committed code" and it becomes a check the ensemble
// cannot drop. A template matcher recognizes common governance intents; novel
// rules fall back to an LLM-backed compiler in production (the result is still a
// deterministic regex check, reviewed before enabling). Still off by default.

export type CompileResult =
  | { ok: true; rule: PolicyRule; matcher: string }
  | { ok: false; error: string };

interface Matcher {
  name: string;
  build(text: string): PolicyRule | null;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

// A reusable line-scanning rule.
function scanRule(opts: {
  id: string;
  title: string;
  severity: Severity;
  test: (line: string) => boolean;
  message: string;
  langs?: RegExp;
}): PolicyRule {
  return {
    id: opts.id,
    title: opts.title,
    severity: opts.severity,
    category: "governance",
    evaluate(ctx: PolicyContext): PolicyViolation[] {
      const out: PolicyViolation[] = [];
      for (const f of ctx.files) {
        if (opts.langs && !opts.langs.test(f.path)) continue;
        const lines = f.content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (opts.test(lines[i])) out.push({ path: f.path, line: i + 1, message: opts.message });
        }
      }
      return out;
    },
  };
}

const MATCHERS: Matcher[] = [
  {
    name: "endpoint-auth",
    build: (t) => (/endpoint|route|handler/i.test(t) && /(auth|authoriz|authenticat)/i.test(t) && /(without|no|missing|need|require|must)/i.test(t) ? endpointNeedsAuth : null),
  },
  {
    name: "forbidden-call",
    build: (t) => {
      const m = /(?:disallow|ban|forbid|no|don'?t use|avoid)\s+(?:calls?\s+to\s+|use of\s+)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*(?:\(|calls?|\b)/i.exec(t);
      if (!m) return null;
      const call = m[1];
      const re = new RegExp(`\\b${call.replace(/\./g, "\\.")}\\s*\\(`);
      return scanRule({ id: `custom/no-call/${slug(call)}`, title: `Disallowed call: ${call}()`, severity: "medium", test: (l) => re.test(l), message: `Org policy forbids calling ${call}().` });
    },
  },
  {
    name: "forbidden-marker",
    build: (t) => {
      const m = /(?:no|disallow|forbid|reject)\s+(TODO|FIXME|XXX|HACK|debugger)\b/i.exec(t);
      if (!m) return null;
      const marker = m[1].toUpperCase();
      const re = new RegExp(`\\b${marker}\\b`, "i");
      return scanRule({ id: `custom/no-marker/${slug(marker)}`, title: `Disallowed marker: ${marker}`, severity: "low", test: (l) => re.test(l), message: `Org policy forbids "${marker}" markers in committed code.` });
    },
  },
  {
    name: "banned-module",
    build: (t) => {
      const m = /(?:ban|disallow|forbid|don'?t (?:use|import)|avoid|no)\s+(?:the\s+)?(?:import of\s+|module\s+|package\s+|library\s+|dependency\s+)?["']?([\w@/\-.]+)["']?/i.exec(t);
      if (!m || !/import|module|package|library|dependency/i.test(t)) return null;
      const mod = m[1];
      return {
        id: `custom/banned-import/${slug(mod)}`,
        title: `Banned import: ${mod}`,
        severity: "medium" as Severity,
        category: "governance",
        evaluate(ctx: PolicyContext): PolicyViolation[] {
          const out: PolicyViolation[] = [];
          const re = new RegExp(`(?:from|require\\(|import)\\s*["']${mod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`);
          for (const f of ctx.files) {
            const lines = f.content.split("\n");
            for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) out.push({ path: f.path, line: i + 1, message: `Module "${mod}" is banned by org policy.` });
          }
          return out;
        },
      };
    },
  },
  {
    name: "max-file-length",
    build: (t) => {
      const m = /files?\s+(?:must|should)?\s*(?:be\s+)?(?:under|less than|no more than|at most|<=?)\s*(\d+)\s*lines/i.exec(t);
      if (!m) return null;
      const max = parseInt(m[1], 10);
      return {
        id: `custom/max-file-length/${max}`,
        title: `File exceeds ${max} lines`,
        severity: "low" as Severity,
        category: "governance",
        evaluate(ctx: PolicyContext): PolicyViolation[] {
          const out: PolicyViolation[] = [];
          for (const f of ctx.files) {
            const n = f.content.split("\n").length;
            if (n > max) out.push({ path: f.path, line: 1, message: `File has ${n} lines; org policy caps files at ${max}.` });
          }
          return out;
        },
      };
    },
  },
  {
    name: "require-license-header",
    build: (t) =>
      /(every file|all files|require).*(license header|copyright header|copyright notice)/i.test(t)
        ? {
            id: "custom/require-license-header",
            title: "Missing license/copyright header",
            severity: "low" as Severity,
            category: "governance",
            evaluate(ctx: PolicyContext): PolicyViolation[] {
              const out: PolicyViolation[] = [];
              for (const f of ctx.files) {
                if (!/\.(js|ts|jsx|tsx|go|py|java|c|cpp|cs)$/i.test(f.path)) continue;
                const head = f.content.split("\n").slice(0, 5).join("\n");
                if (!/copyright|license|spdx-license-identifier/i.test(head)) out.push({ path: f.path, line: 1, message: "File is missing the required license/copyright header." });
              }
              return out;
            },
          }
        : null,
  },
];

export function compileEnglishRule(text: string): CompileResult {
  for (const matcher of MATCHERS) {
    const rule = matcher.build(text);
    if (rule) return { ok: true, rule, matcher: matcher.name };
  }
  return { ok: false, error: `could not compile rule: "${text.trim().slice(0, 80)}" (no matching template; route to the LLM compiler)` };
}
