// Detect a project's build/test setup from its files so the verifier knows how to
// install deps and run a single test + the suite. Best-effort across the common
// ecosystems; returns null when nothing is recognized (→ INCONCLUSIVE).

export interface Command {
  cmd: string;
  args: string[];
}

export interface ProjectSetup {
  language: string;
  framework: string;
  install?: Command;
  /** Run one test file. */
  runTest(testPath: string): Command;
  /** Run the existing suite. */
  runSuite(): Command;
  /** Where to put a generated test for a given base name. */
  testPathFor(base: string): string;
}

export function detectSetup(files: Array<{ path: string }>): ProjectSetup | null {
  const set = new Set(files.map((f) => f.path));
  const has = (p: string) => set.has(p);
  const anyExt = (ext: string) => files.some((f) => f.path.endsWith(ext));

  if (has("go.mod") || anyExt(".go")) {
    return {
      language: "go",
      framework: "go test",
      runTest: (t) => ({ cmd: "go", args: ["test", "-run", ".", "-v", "./" + dir(t)] }),
      runSuite: () => ({ cmd: "go", args: ["test", "./..."] }),
      testPathFor: (base) => `${base}_repro_test.go`,
    };
  }
  if (has("package.json") || anyExt(".mjs") || anyExt(".js") || anyExt(".ts")) {
    // Node's built-in test runner — no install needed for a self-contained test.
    return {
      language: "javascript",
      framework: "node:test",
      runTest: (t) => ({ cmd: process.execPath, args: ["--test", t] }),
      runSuite: () => ({ cmd: process.execPath, args: ["--test"] }),
      testPathFor: (base) => `${base}.repro.test.mjs`,
    };
  }
  if (has("requirements.txt") || has("pyproject.toml") || anyExt(".py")) {
    return {
      language: "python",
      framework: "pytest",
      install: has("requirements.txt") ? { cmd: "pip", args: ["install", "-r", "requirements.txt"] } : undefined,
      runTest: (t) => ({ cmd: "python", args: ["-m", "pytest", "-q", t] }),
      runSuite: () => ({ cmd: "python", args: ["-m", "pytest", "-q"] }),
      testPathFor: (base) => `test_${base}_repro.py`,
    };
  }
  return null;
}

function dir(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "." : p.slice(0, i);
}
