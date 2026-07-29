import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LocalSandboxBackend, FakeSandboxBackend, shallowClone, containerPath } from "@cavix/sandbox";

const NODE = process.execPath;

test("LocalSandbox: write, exec, read, destroy", async () => {
  const sbx = await new LocalSandboxBackend().provision({});
  await sbx.writeFile("hello.txt", "hi there");
  assert.equal(await sbx.readFile("hello.txt"), "hi there");

  const r = await sbx.exec(NODE, ["-e", "console.log('out'); console.error('err')"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /out/);
  assert.match(r.stderr, /err/);
  assert.equal(r.timedOut, false);

  await sbx.destroy();
  await assert.rejects(() => sbx.readFile("hello.txt"), "workspace removed after destroy");
});

test("LocalSandbox: enforces the wall-clock cap (kills runaway exec)", async () => {
  const sbx = await new LocalSandboxBackend().provision({ limits: { timeoutMs: 300 } });
  const r = await sbx.exec(NODE, ["-e", "setTimeout(()=>{}, 10000)"]);
  assert.equal(r.timedOut, true, "long-running exec should be killed");
  assert.notEqual(r.code, 0);
  await sbx.destroy();
});

test("LocalSandbox: confines file paths to the workspace", async () => {
  const sbx = await new LocalSandboxBackend().provision({});
  await assert.rejects(() => sbx.writeFile("../escape.txt", "x"), /escapes sandbox/);
  await sbx.destroy();
});

test("DockerSandbox: confines file paths to the workspace, exactly as Local does", () => {
  // Two implementations of one port that disagree about this cannot be swapped,
  // which is the entire reason the port exists. Local has always refused a
  // traversal; Docker handed the path to the container as written and let the
  // read-only rootfs turn it into a silent no-op.
  //
  // Tested through the exported helper rather than a container, because a
  // confinement check that only runs where a daemon is installed is one nobody
  // ever watches fail.
  assert.equal(containerPath("/work", "src/a.ts"), "/work/src/a.ts");
  assert.equal(containerPath("/work", "./src/../a.ts"), "/work/a.ts");
  // A leading slash is relative to the workdir, not to the container root: the
  // paths arriving here are repository paths, and one of them starting with "/"
  // is not a request for /etc.
  assert.equal(containerPath("/work", "/nested/a.ts"), "/work/nested/a.ts");
  for (const escape of ["../escape.txt", "../../etc/passwd", "a/../../b", "..", "a/b/../../../c"]) {
    assert.throws(() => containerPath("/work", escape), /escapes sandbox/, escape);
  }
});

test("FakeSandbox: scripted exec for hermetic verification tests", async () => {
  const backend = new FakeSandboxBackend((cmd, args) =>
    cmd === "npm" && args[0] === "test" ? { code: 1, stdout: "1 failing" } : { code: 0 },
  );
  const sbx = await backend.provision({});
  await sbx.writeFile("a.js", "x");
  assert.equal((await sbx.exec("npm", ["test"])).code, 1);
  assert.equal((await sbx.exec("ls", [])).code, 0);
  await sbx.destroy();
});

test("shallowClone: fetches a single commit from a local repo (no network)", async () => {
  const src = await mkdtemp(path.join(os.tmpdir(), "cavix-src-"));
  const dst = await mkdtemp(path.join(os.tmpdir(), "cavix-dst-"));
  try {
    // Build a tiny source repo.
    const run = (args: string[]) => execFileSync("git", args, { cwd: src, stdio: "ignore" });
    run(["init", "-q"]);
    run(["config", "user.email", "t@t"]);
    run(["config", "user.name", "t"]);
    execFileSync("git", ["commit", "--allow-empty", "-m", "root"], { cwd: src, stdio: "ignore" });
    // Add a file and commit.
    execFileSync(NODE, ["-e", `require('fs').writeFileSync(process.argv[1],'hello')`, path.join(src, "file.txt")]);
    run(["add", "."]);
    execFileSync("git", ["commit", "-q", "-m", "add file"], { cwd: src });

    await shallowClone({ repoUrl: src, ref: "HEAD", dir: dst });
    const got = execFileSync(NODE, ["-e", `process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))`, path.join(dst, "file.txt")]).toString();
    assert.equal(got, "hello");
  } finally {
    await rm(src, { recursive: true, force: true });
    await rm(dst, { recursive: true, force: true });
  }
});
