import type { Finding } from "@cavix/core";
import { lineAt, type Scanner, type SourceFile } from "./types.ts";

// SecretScanner: regex detection of committed credentials. Deterministic and
// high-confidence — these become source="secret" findings the LLM cannot drop.
// Patterns are conservative (low false-positive) and easily extended via config.

interface SecretPattern {
  id: string;
  title: string;
  re: RegExp;
  severity: Finding["severity"];
}

const PATTERNS: SecretPattern[] = [
  { id: "aws-access-key-id", title: "AWS access key id committed", re: /\bAKIA[0-9A-Z]{16}\b/, severity: "high" },
  { id: "private-key", title: "Private key committed", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, severity: "critical" },
  { id: "generic-api-key", title: "Hardcoded API key/secret", re: /\b(?:api[_-]?key|secret|token|passwd|password)\b\s*[:=]\s*["'][^"'\s]{12,}["']/i, severity: "high" },
  { id: "slack-token", title: "Slack token committed", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/, severity: "high" },
  { id: "google-api-key", title: "Google API key committed", re: /\bAIza[0-9A-Za-z\-_]{35}\b/, severity: "high" },
  { id: "github-token", title: "GitHub token committed", re: /\bgh[pousr]_[0-9A-Za-z]{36}\b/, severity: "high" },
];

export class SecretScanner implements Scanner {
  readonly id = "secret-scanner";

  async run(files: SourceFile[]): Promise<Finding[]> {
    const out: Finding[] = [];
    for (const file of files) {
      for (const p of PATTERNS) {
        const m = p.re.exec(file.content);
        if (!m) continue;
        out.push({
          path: file.path,
          line: lineAt(file.content, m.index),
          severity: p.severity,
          category: "security",
          title: p.title,
          body: `A value matching a ${p.id} pattern is committed in source. Rotate it and load secrets from the environment or a secret manager instead.`,
          source: "secret",
          ruleId: `secret/${p.id}`,
          confidence: 0.95,
        });
      }
    }
    return out;
  }
}
