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

/**
 * The same patterns, global, so every occurrence is found rather than the first.
 *
 * Derived here rather than written with `/g` above so the literals stay readable
 * and nobody has to notice a one-character flag to understand the behaviour. The
 * originals are left non-global on purpose: a shared non-global RegExp carries
 * no `lastIndex`, so it cannot leak match position from one file into the next.
 */
const GLOBAL_PATTERNS: SecretPattern[] = PATTERNS.map((p) => ({
  ...p,
  re: p.re.flags.includes("g") ? p.re : new RegExp(p.re.source, `${p.re.flags}g`),
}));

/**
 * Matches reported per pattern per file.
 *
 * A cap rather than no cap because a fixture file, a rotated-key changelog or a
 * test vector can hold hundreds, and a review with three hundred inline comments
 * is a review nobody reads. It is high enough that a real leak is never the one
 * that gets cut.
 */
const MAX_MATCHES_PER_FILE = 20;

export class SecretScanner implements Scanner {
  readonly id = "secret-scanner";

  async run(files: SourceFile[]): Promise<Finding[]> {
    const out: Finding[] = [];
    for (const file of files) {
      for (const p of GLOBAL_PATTERNS) {
        // EVERY match, not just the first.
        //
        // This used to be a bare `exec`, which returns one match and stops. A
        // file committing an AWS key on line 12 and a second one on line 400
        // reported the first and said nothing about the second, so the one
        // nobody was told about is the one nobody rotates. For a secret
        // scanner that is the whole job, not a completeness nicety.
        //
        // `matchAll` operates on an internal clone of the pattern, so the
        // shared module-level RegExp objects never carry `lastIndex` state from
        // one file into the next.
        let seen = 0;
        for (const m of file.content.matchAll(p.re)) {
          if (m.index === undefined) continue;
          if (++seen > MAX_MATCHES_PER_FILE) break;
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
    }
    return out;
  }
}
