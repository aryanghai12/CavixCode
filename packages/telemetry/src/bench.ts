import type { Sandbox } from "@cavix/sandbox";

// Optionally run the affected benchmark IN THE SANDBOX and compare to baseline.
// The parser pulls the metric out of the tool's output; the verifier-grade
// isolation (no egress, caps) applies here too.
export async function runBenchmarkInSandbox(
  sandbox: Sandbox,
  cmd: string,
  args: string[],
  parse: (stdout: string) => number,
): Promise<{ value: number; raw: string }> {
  const r = await sandbox.exec(cmd, args);
  const raw = r.stdout + r.stderr;
  return { value: parse(raw), raw };
}

/** Parse the first number followed by an optional unit (ms/ns/ops) from output. */
export function parseFirstNumber(stdout: string): number {
  const m = /(-?\d+(?:\.\d+)?)/.exec(stdout);
  if (!m) throw new Error("no numeric metric in benchmark output");
  return parseFloat(m[1]);
}
