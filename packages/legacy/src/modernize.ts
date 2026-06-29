import type { Finding } from "@cavix/core";
import type { Verifier, VerificationResult, VerifyContext } from "@cavix/verifier";

// Modernization mode: propose a concrete migration for a legacy finding, then run
// the migrated code through the SAME Stage 10 verification before suggesting it.
// Cavix never proposes a migration it hasn't confirmed preserves behavior.

export interface Migration {
  path: string;
  title: string;
  rationale: string;
  targetLanguage: string;
  before: string;
  after: string;
}

export interface ModernizationProposal {
  finding: Finding;
  migration: Migration;
}

// Pattern-based migration proposals keyed by the legacy rule id.
export function proposeModernization(finding: Finding, fileContent: string): ModernizationProposal | null {
  const line = fileContent.split("\n")[finding.line - 1] ?? "";
  switch (finding.ruleId) {
    case "cpp/unsafe-string": {
      const m = /\bstrcpy\s*\(\s*([^,]+),\s*([^)]+)\)/.exec(line);
      if (!m) return null;
      return mk(finding, {
        title: "strcpy → strncpy (bounded copy)",
        rationale: "Replace the unbounded strcpy with strncpy bounded by the destination size to remove the overflow.",
        targetLanguage: "c",
        before: line.trim(),
        after: `strncpy(${m[1].trim()}, ${m[2].trim()}, sizeof(${m[1].trim()}) - 1);`,
      });
    }
    case "plsql/dynamic-sql-concat": {
      return mk(finding, {
        title: "Concatenated dynamic SQL → bind variables",
        rationale: "Use EXECUTE IMMEDIATE ... USING with bind variables to eliminate the injection.",
        targetLanguage: "plsql",
        before: line.trim(),
        after: line.replace(/\|\|\s*([A-Za-z_]\w*)/g, "").replace(/;?\s*$/, " USING $1;").trim(),
      });
    }
    case "cobol/goto": {
      return mk(finding, {
        title: "GO TO → PERFORM",
        rationale: "Replace GO TO with a PERFORM of the target paragraph to restore structured flow.",
        targetLanguage: "cobol",
        before: line.trim(),
        after: line.replace(/\bGO\s+TO\b/i, "PERFORM").trim(),
      });
    }
    default:
      return null;
  }
}

function mk(finding: Finding, m: Omit<Migration, "path">): ModernizationProposal {
  return { finding, migration: { path: finding.path, ...m } };
}

export interface VerifiedModernization {
  proposal: ModernizationProposal;
  result: VerificationResult;
  /** Only true when Stage 10 confirmed the migration preserves behavior. */
  suggest: boolean;
}

// Run the migration through Stage 10. The verifier writes the MODERNIZED files,
// generates a behavior/equivalence test (semantics: passes-on-correct), and runs
// it; we suggest the migration only if it VERIFIES.
export async function verifyModernization(
  proposal: ModernizationProposal,
  verifier: Verifier,
  ctx: VerifyContext,
): Promise<VerifiedModernization> {
  const finding: Finding = {
    path: proposal.migration.path,
    line: proposal.finding.line,
    severity: "info",
    category: "security", // equivalence test passes-on-correct (exploit-passes semantics)
    title: `Modernization: ${proposal.migration.title}`,
    body: proposal.migration.rationale,
    source: "llm",
    confidence: 0.9,
  };
  const result = await verifier.verify(finding, ctx);
  return { proposal, result, suggest: result.status === "VERIFIED" };
}
