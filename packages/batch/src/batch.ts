import type { Finding } from "@cavix/core";
import type { Verifier } from "@cavix/verifier";
import { proposeModernization, verifyModernization, type Migration } from "@cavix/legacy";

// Modernization at scale. Each candidate change is independently gated through the
// SAME Stage 10 verification — a migration that doesn't verify is excluded, never
// applied. The output is a per-change ledger plus the verified changes grouped by
// repo (ready to become human-approvable fix PRs).

export interface MigrationTarget {
  repo: string;
  file: { path: string; content: string };
  finding: Finding;
}

export interface BatchOptions {
  verifier: Verifier;
  concurrency?: number;
  /** Extra scaffolding files needed so the sandbox can build/test (e.g. package.json). */
  scaffolding?: Array<{ path: string; content: string }>;
  onProgress?: (done: number, total: number) => void;
}

export interface BatchChangeResult {
  repo: string;
  path: string;
  proposed: boolean;
  verified: boolean;
  status: string;
  reason: string;
  migration?: Migration;
  /** The migrated file content, present only when verified. */
  newContent?: string;
}

export interface BatchResult {
  results: BatchChangeResult[];
  proposedCount: number;
  verifiedCount: number;
  excludedCount: number;
}

export async function runBatchModernization(targets: MigrationTarget[], opts: BatchOptions): Promise<BatchResult> {
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const scaffolding = opts.scaffolding ?? [{ path: "package.json", content: "{}" }];
  const results: BatchChangeResult[] = new Array(targets.length);
  let done = 0;

  // Simple bounded-concurrency pool — migrations verify in parallel sandboxes.
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= targets.length) return;
      results[i] = await processOne(targets[i], opts.verifier, scaffolding);
      opts.onProgress?.(++done, targets.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));

  const verifiedCount = results.filter((r) => r.verified).length;
  const proposedCount = results.filter((r) => r.proposed).length;
  return { results, proposedCount, verifiedCount, excludedCount: proposedCount - verifiedCount };
}

async function processOne(t: MigrationTarget, verifier: Verifier, scaffolding: Array<{ path: string; content: string }>): Promise<BatchChangeResult> {
  const proposal = proposeModernization(t.finding, t.file.content);
  if (!proposal) {
    return { repo: t.repo, path: t.file.path, proposed: false, verified: false, status: "SKIPPED", reason: "no migration template for this finding" };
  }
  const newContent = applyMigration(t.file.content, proposal.migration);
  const ctx = { org: "batch", files: [...scaffolding, { path: t.file.path, content: newContent }] };
  const vm = await verifyModernization(proposal, verifier, ctx);
  return {
    repo: t.repo,
    path: t.file.path,
    proposed: true,
    verified: vm.suggest,
    status: vm.result.status,
    reason: vm.suggest ? "migration verified — preserves behavior" : `excluded: ${vm.result.reason}`,
    migration: proposal.migration,
    newContent: vm.suggest ? newContent : undefined,
  };
}

/** Group verified changes by repo (each group → one human-approvable PR). */
export function verifiedChangesByRepo(result: BatchResult): Map<string, BatchChangeResult[]> {
  const byRepo = new Map<string, BatchChangeResult[]>();
  for (const r of result.results) {
    if (!r.verified) continue;
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
    byRepo.get(r.repo)!.push(r);
  }
  return byRepo;
}

// Replace the migration's `before` line with `after`, preserving indentation.
function applyMigration(content: string, migration: Migration): string {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === migration.before.trim()) {
      const indent = lines[i].slice(0, lines[i].length - lines[i].trimStart().length);
      lines[i] = indent + migration.after.trim();
      break;
    }
  }
  return lines.join("\n");
}
