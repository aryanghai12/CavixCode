import type { Finding } from "@cavix/core";
import type { Verifier, VerificationResult } from "@cavix/verifier";
import type { FixPrTarget, OpenedPr } from "./target.ts";

// The verified fix-PR agent. It proposes a fix ONLY when Stage 10 proves it:
// the bug reproduces (test red), the fix makes it pass (test green), AND the
// existing suite stays green. Anything short of that is NOT proposed. The PR is
// always a DRAFT requiring human approval — Cavix never merges.

export interface FixPrAgentOptions {
  verifier: Verifier;
  target: FixPrTarget;
  baseBranch?: string;
}

export interface ProposeFixInput {
  finding: Finding;
  repo: string;
  org: string;
  /** Current (buggy) repo files needed to build/run. */
  files: Array<{ path: string; content: string }>;
}

export interface FixProposalResult {
  proposed: boolean;
  reason: string;
  verification: VerificationResult;
  pr?: OpenedPr;
}

export class FixPrAgent {
  private readonly verifier: Verifier;
  private readonly target: FixPrTarget;
  private readonly baseBranch: string;

  constructor(opts: FixPrAgentOptions) {
    this.verifier = opts.verifier;
    this.target = opts.target;
    this.baseBranch = opts.baseBranch ?? "main";
  }

  async propose(input: ProposeFixInput): Promise<FixProposalResult> {
    const verification = await this.verifier.verify(input.finding, { org: input.org, files: input.files });

    // The full gate: reproduced + fix works + suite green + we have the fix files.
    const gatePassed =
      verification.status === "VERIFIED" &&
      verification.fixWorks === true &&
      verification.suitePasses === true &&
      (verification.appliedFix?.length ?? 0) > 0;

    if (!gatePassed) {
      return { proposed: false, reason: notProposedReason(verification), verification };
    }

    const headBranch = `cavix/fix/${slug(input.finding)}`;
    const pr = await this.target.createFixPr({
      repo: input.repo,
      baseBranch: this.baseBranch,
      headBranch,
      title: `fix: ${input.finding.title}`,
      body: prBody(input.finding, verification),
      files: verification.appliedFix!,
      draft: true, // human approval required to merge
      labels: ["cavix:verified-fix", "needs-human-approval"],
    });
    return { proposed: true, reason: "fix verified green in the sandbox; draft PR opened for human approval", verification, pr };
  }
}

function notProposedReason(v: VerificationResult): string {
  if (v.status === "UNVERIFIED") return `fix not proposed: ${v.reason}`;
  if (v.status === "INCONCLUSIVE") return `fix not proposed: verification inconclusive (${v.reason})`;
  if (v.fixWorks !== true) return "fix not proposed: candidate fix did not resolve the reproduction";
  if (v.suitePasses !== true) return "fix not proposed: existing test suite did not stay green";
  return "fix not proposed: no verified fix available";
}

function prBody(finding: Finding, v: VerificationResult): string {
  const lines = [
    `## 🔧 Cavix verified fix`,
    "",
    `**Finding:** ${finding.title} (\`${finding.path}:${finding.line}\`)`,
    "",
    `This fix was **proven in an isolated sandbox** before this PR was opened:`,
    `- ❌ before fix: the reproduction test failed (bug confirmed)`,
    `- ✅ after fix: the reproduction test passes`,
    `- ✅ the existing test suite stayed green`,
    "",
    "<details><summary>Reproduction test</summary>",
    "",
    "```",
    (v.testCode ?? "").trim(),
    "```",
    "</details>",
    "",
    "> ⚠️ **Requires human approval to merge.** Cavix opens this as a draft and never auto-merges.",
  ];
  return lines.join("\n");
}

function slug(f: Finding): string {
  return `${f.path}-${f.line}-${f.ruleId ?? f.title}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}
