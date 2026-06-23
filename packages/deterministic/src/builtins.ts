import type { Finding, Severity } from "@cavix/core";
import type { Scanner, SourceFile } from "./types.ts";

// BuiltinRuleScanner: in-process, high-precision SAST heuristics. These are the
// always-available deterministic backstop — no external binary needed — so even
// in air-gapped/minimal installs Cavix has a baseline of source="sast" findings
// the LLM cannot silently drop. External linters (tools.ts) add depth on top.

type Lang = "js" | "py" | "go" | "any";

interface LineRule {
  id: string;
  title: string;
  category: string;
  severity: Severity;
  langs: Lang[];
  re: RegExp;
  body: string;
  confidence: number;
}

const EXT_LANG: Record<string, Lang> = {
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js",
  py: "py", go: "go",
};

function langOf(path: string): Lang | "unknown" {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return EXT_LANG[ext] ?? "unknown";
}

const RULES: LineRule[] = [
  { id: "sql-injection", title: "SQL built by string concatenation", category: "security", severity: "critical", langs: ["js", "py"],
    re: /(?:query|execute|exec|prepare|raw)\s*\([^)]*["'`][^)]*\+\s*\w/, confidence: 0.85,
    body: "A SQL string is built by concatenating a variable. Use parameterized queries / prepared statements." },
  { id: "command-injection-os-system", title: "Shell command built from concatenation", category: "security", severity: "critical", langs: ["py"],
    re: /os\.system\s*\([^)]*\+/, confidence: 0.85,
    body: "`os.system` is called with a concatenated string — command injection. Use subprocess with an argument list and no shell." },
  { id: "command-injection-shell-true", title: "subprocess with shell=True", category: "security", severity: "high", langs: ["py"],
    re: /subprocess\.(?:call|run|Popen|check_output)\([^)]*shell\s*=\s*True/, confidence: 0.7,
    body: "shell=True with dynamic input risks command injection. Pass an argument list and avoid the shell." },
  { id: "command-injection-exec", title: "child_process exec with concatenation", category: "security", severity: "high", langs: ["js"],
    re: /\bexec(?:Sync)?\s*\([^)]*\+/, confidence: 0.7,
    body: "`exec` with a concatenated command risks command injection. Use execFile/spawn with an argument array." },
  { id: "eval-use", title: "Use of eval()", category: "security", severity: "high", langs: ["js", "py"],
    re: /(?<![.\w])eval\s*\(/, confidence: 0.6,
    body: "eval executes arbitrary code. Avoid it; parse/validate input explicitly." },
  { id: "weak-hash", title: "Weak hash (MD5/SHA1)", category: "security", severity: "high", langs: ["js", "py", "go"],
    re: /\b(?:hashlib\.)?(?:md5|sha1)\s*\(/i, confidence: 0.7,
    body: "MD5/SHA1 are unsuitable for passwords or integrity. Use bcrypt/scrypt/argon2 for passwords, SHA-256+ otherwise." },
  { id: "dom-xss-innerhtml", title: "Unsanitized innerHTML assignment", category: "security", severity: "high", langs: ["js"],
    re: /\.innerHTML\s*=\s*[^;]*\+/, confidence: 0.75,
    body: "Assigning concatenated, possibly user-controlled HTML to innerHTML enables DOM XSS. Use textContent or sanitize." },
  { id: "document-write", title: "document.write with dynamic content", category: "security", severity: "medium", langs: ["js"],
    re: /document\.write\s*\([^)]*\+/, confidence: 0.6,
    body: "document.write with dynamic input can inject markup/script." },
  { id: "open-redirect", title: "Open redirect from request input", category: "security", severity: "medium", langs: ["js"],
    re: /\.redirect\s*\(\s*req\.(?:query|params|body)/, confidence: 0.8,
    body: "Redirect target comes straight from the request — open redirect. Validate against an allowlist." },
  { id: "tls-verify-disabled-py", title: "TLS verification disabled", category: "security", severity: "high", langs: ["py"],
    re: /verify\s*=\s*False/, confidence: 0.8,
    body: "Disabling TLS verification exposes traffic to MITM. Keep verification on." },
  { id: "tls-verify-disabled-js", title: "TLS verification disabled", category: "security", severity: "high", langs: ["js"],
    re: /rejectUnauthorized\s*:\s*false/, confidence: 0.8,
    body: "rejectUnauthorized:false disables certificate validation." },
  { id: "yaml-load-unsafe", title: "Unsafe yaml.load", category: "security", severity: "high", langs: ["py"],
    re: /yaml\.load\s*\((?![^)]*Loader\s*=\s*yaml\.SafeLoader)/, confidence: 0.7,
    body: "yaml.load without SafeLoader can execute arbitrary objects. Use yaml.safe_load." },
  { id: "pickle-load", title: "Unsafe pickle deserialization", category: "security", severity: "high", langs: ["py"],
    re: /pickle\.loads?\s*\(/, confidence: 0.6,
    body: "Unpickling untrusted data executes arbitrary code. Use a safe format (JSON)." },
  { id: "wildcard-cors", title: "Wildcard CORS origin", category: "security", severity: "medium", langs: ["js", "py", "go"],
    re: /Access-Control-Allow-Origin["']?\s*[:,]\s*["']\*/, confidence: 0.6,
    body: "Allowing any origin with credentials is unsafe. Restrict to an allowlist." },
];

export class BuiltinRuleScanner implements Scanner {
  readonly id = "builtin-sast";

  async run(files: SourceFile[]): Promise<Finding[]> {
    const out: Finding[] = [];
    for (const file of files) {
      const lang = langOf(file.path);
      if (lang === "unknown") continue;
      const lines = file.content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        for (const rule of RULES) {
          if (!rule.langs.includes("any") && !rule.langs.includes(lang)) continue;
          if (rule.re.test(lines[i])) {
            out.push({
              path: file.path,
              line: i + 1,
              severity: rule.severity,
              category: rule.category,
              title: rule.title,
              body: rule.body,
              source: "sast",
              ruleId: `builtin/${rule.id}`,
              confidence: rule.confidence,
            });
          }
        }
      }
      out.push(...ssrfContentRule(file, lang));
    }
    return out;
  }
}

// A small data-flow heuristic: a request-derived variable flown into an outbound
// fetch/get is a likely SSRF. This is the kind of cross-line reasoning a single
// regex misses but a deterministic content rule can capture cheaply.
function ssrfContentRule(file: SourceFile, lang: Lang | "unknown"): Finding[] {
  if (lang !== "js" && lang !== "py") return [];
  const lines = file.content.split("\n");
  // Variables assigned from request input.
  const tainted = new Set<string>();
  const assignRe = /(?:const|let|var)?\s*([a-z_]\w*)\s*=\s*req\.(?:query|params|body)/i;
  for (const l of lines) {
    const m = assignRe.exec(l);
    if (m) tainted.add(m[1]);
  }
  if (tainted.size === 0) return [];
  const out: Finding[] = [];
  const sinkRe = /\b(?:fetch|got|axios(?:\.get)?|requests\.get|urlopen)\s*\(\s*([a-z_]\w*)\b/i;
  for (let i = 0; i < lines.length; i++) {
    const m = sinkRe.exec(lines[i]);
    if (m && tainted.has(m[1])) {
      out.push({
        path: file.path,
        line: i + 1,
        severity: "high",
        category: "security",
        title: "Server-side request forgery (request-controlled URL)",
        body: `\`${m[1]}\` is derived from request input and used as an outbound request URL — SSRF. Validate the host against an allowlist.`,
        source: "sast",
        ruleId: "builtin/ssrf",
        confidence: 0.7,
      });
    }
  }
  return out;
}
