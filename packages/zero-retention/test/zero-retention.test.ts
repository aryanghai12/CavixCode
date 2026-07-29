import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { Finding } from "@cavix/core";
import type { Sandbox } from "@cavix/sandbox";
import { LocalSandboxBackend, FakeSandboxBackend } from "@cavix/sandbox";
import {
  ZeroRetention,
  buildAttestation,
  checkPurged,
  explainAttestation,
  metadataOnly,
  verdictOf,
  type PurgeCheck,
} from "@cavix/zero-retention";

/** A sandbox stub with only the fields a purge check reads. */
function sandbox(backend: string, over: Partial<Sandbox> = {}): Sandbox {
  return { id: "sbx-1", backend, workdir: "/work", ...over } as Sandbox;
}

// ── the check itself ────────────────────────────────────────────────────────

test("local: the workspace directory is really gone, and its absence is measured", async () => {
  const backend = new LocalSandboxBackend();
  const sbx = await backend.provision({});
  await sbx.writeFile("customer/secret.js", "const apiKey='shhh'; // proprietary");
  assert.equal(fs.existsSync(sbx.workdir), true, "present during the review");

  await sbx.destroy();
  const check = await checkPurged(sbx);
  assert.equal(check.status, "purged");
  assert.equal(check.backend, "local");
  assert.match(check.check, /absent from the host filesystem/);
});

test("local: a workspace that survived is a violation, and the path never reaches the record", async () => {
  const logged: Array<Record<string, unknown> | undefined> = [];
  const check = await checkPurged(sandbox("local", { workdir: "/tmp/cavix-sbx-leftover" }), {
    exists: () => true,
    logger: { error: (_m, meta) => logged.push(meta) },
  });
  assert.equal(check.status, "residual");
  assert.equal(check.residualCount, 1);
  // A count on the record, the path in the operator's log. A retention proof
  // carrying a filesystem path from the machine that read a customer's private
  // repository is itself a retention problem, and one that survives for years.
  assert.equal(JSON.stringify(check).includes("leftover"), false);
  assert.equal(logged[0]?.workdir, "/tmp/cavix-sbx-leftover", "but the operator can still fix it");
});

test("docker: the check asks the daemon, because /work was never a host path", async () => {
  // This is the bug the whole file exists for. The original check looked for
  // `sandbox.workdir` on the host; on Docker that is `/work` INSIDE a container
  // and no such host path was ever created, so the check saw nothing, found
  // nothing, and reported clean. On the only backend a customer runs, the
  // zero-retention proof verified precisely nothing.
  const asked: string[][] = [];
  const check = await checkPurged(sandbox("docker", { id: "cavix-abc123" }), {
    run: async (cmd, args) => {
      asked.push([cmd, ...args]);
      return { code: 0, stdout: "" }; // no container listed
    },
  });
  assert.equal(check.status, "purged");
  assert.ok(asked[0].includes("name=^cavix-abc123$"), "and it asks about THIS container");
  assert.match(check.check, /tmpfs that cannot outlive it/);
});

test("docker: a container still listed is a violation", async () => {
  const check = await checkPurged(sandbox("docker"), {
    run: async () => ({ code: 0, stdout: "a1b2c3d4\n" }),
  });
  assert.equal(check.status, "residual");
  assert.equal(check.residualCount, 1);
});

test("docker: an unreachable daemon is unverifiable, NOT clean", async () => {
  // The distinction that makes the artefact worth anything. "We could not check"
  // and "we checked and it was gone" are different claims, and collapsing them
  // is how a proof becomes a slogan.
  const failing = await checkPurged(sandbox("docker"), { run: async () => ({ code: 1, stdout: "" }) });
  assert.equal(failing.status, "unverifiable");
  assert.equal(failing.residualCount, undefined);

  const throwing = await checkPurged(sandbox("docker"), {
    run: async () => {
      throw new Error("docker not installed");
    },
  });
  assert.equal(throwing.status, "unverifiable");
});

test("a backend with nothing inspectable says so rather than claiming clean", async () => {
  for (const backend of ["cloudflare", "fake", "firecracker"]) {
    const check = await checkPurged(sandbox(backend));
    assert.equal(check.status, "unverifiable", backend);
    assert.match(check.check, /exposes nothing this process can inspect/);
  }
});

// ── the verdict ─────────────────────────────────────────────────────────────

const purged: PurgeCheck = { backend: "docker", check: "c", status: "purged" };
const unverifiable: PurgeCheck = { backend: "cloudflare", check: "c", status: "unverifiable" };
const residual: PurgeCheck = { backend: "local", check: "c", status: "residual", residualCount: 1 };

test("one surviving sandbox outweighs every clean one", () => {
  // Averaging it away would be the exact dishonesty this artefact prevents.
  assert.equal(verdictOf([purged, purged, purged, residual]), "violated");
});

test("a mixed deployment is partial, not rounded to either end", () => {
  assert.equal(verdictOf([purged, unverifiable]), "partial");
  assert.equal(verdictOf([purged, purged]), "proven");
  assert.equal(verdictOf([unverifiable, unverifiable]), "unverified");
  assert.equal(verdictOf([]), "unverified");
});

test("the sentence a customer reads says what was measured, not that all is well", () => {
  const proven = buildAttestation({ reviewId: "r1", org: "acme", checks: [purged, purged] });
  assert.match(explainAttestation(proven), /2 of 2 sandboxes verified destroyed/);

  const none = buildAttestation({ reviewId: "r2", org: "acme", checks: [] });
  assert.match(explainAttestation(none), /No sandbox was provisioned/);

  const mixed = buildAttestation({ reviewId: "r3", org: "acme", checks: [purged, unverifiable] });
  assert.match(explainAttestation(mixed), /rests on the backend's contract rather than on a check/);

  const bad = buildAttestation({ reviewId: "r4", org: "acme", checks: [residual] });
  assert.match(explainAttestation(bad), /retention violation/);
});

test("the attestation carries no code, no paths and no repository", () => {
  // Point four of the brief: whatever is recorded must not become the retention
  // problem it is proving does not exist.
  const a = buildAttestation({ reviewId: "rev_1", org: "acme", checks: [purged, unverifiable] });
  assert.equal(a.sandboxes, 2);
  const json = JSON.stringify(a);
  assert.equal(json.includes("workdir"), false);
  assert.equal(json.includes("residualPaths"), false);
  // The only identifiers are the review and the workspace, and an auditor asking
  // about a review from four months ago has nothing else to ask with.
  assert.deepEqual(Object.keys(a).sort(), ["at", "checks", "org", "reviewId", "sandboxes", "verdict"]);
});

// ── the wrapper (the air-gapped demo and compliance harnesses) ──────────────

test("customer code exists during the review and is gone after", async () => {
  const audited: Array<Record<string, unknown>> = [];
  const zr = new ZeroRetention({
    backend: new LocalSandboxBackend(),
    audit: { append: (_a, _action, _t, meta) => audited.push(meta ?? {}) },
  });

  let workdir = "";
  const { attestation } = await zr.runReview({ reviewId: "rev_1", org: "acme" }, async (sbx) => {
    workdir = sbx.workdir;
    await sbx.writeFile("customer/secret.js", "const apiKey='shhh'; // proprietary");
    assert.equal(fs.existsSync(workdir + "/customer/secret.js"), true);
    return "reviewed";
  });

  assert.equal(fs.existsSync(workdir), false, "workspace purged after the review");
  assert.equal(attestation.verdict, "proven");
  assert.equal(audited[0].verdict, "proven", "and attested in the audit trail");
});

test("a failed purge fails loudly HERE, and names no path when it does", async () => {
  const zr = new ZeroRetention({
    backend: new FakeSandboxBackend(),
    purgeCheck: async () => residual,
  });
  await assert.rejects(
    () => zr.runReview({ reviewId: "rev_2", org: "acme" }, async () => "x"),
    (err: Error) => {
      assert.match(err.message, /zero-retention violated/);
      assert.equal(err.message.includes("/"), false, "this string ends up in logs and error trackers");
      return true;
    },
  );
});

test("teardown happens even if the review throws", async () => {
  const zr = new ZeroRetention({ backend: new FakeSandboxBackend() });
  let destroyed = false;
  await assert.rejects(() =>
    zr.runReview({ reviewId: "r", org: "acme" }, async (sbx) => {
      const orig = sbx.destroy.bind(sbx);
      sbx.destroy = async () => {
        destroyed = true;
        return orig();
      };
      throw new Error("review blew up");
    }),
  );
  assert.equal(destroyed, true, "sandbox destroyed despite the error");
});

test("metadataOnly strips code and keeps classification", () => {
  const f: Finding = {
    path: "a.js", line: 5, severity: "high", category: "security", title: "SQL injection",
    body: 'db.query("SELECT ... " + id)  // contains customer code',
    suggestion: "db.query('... ?', [id])",
    source: "llm", confidence: 0.9, agent: "security",
    evidence: [{ path: "b.js", line: 1, snippet: "const id = req.query.id // customer code" }],
  };
  const md = metadataOnly(f) as Record<string, unknown>;
  assert.equal(md.title, "SQL injection");
  assert.equal("body" in md, false, "no code body persisted");
  assert.equal("suggestion" in md, false, "no code suggestion persisted");
  assert.equal("evidence" in md, false, "no code snippets persisted");
});
