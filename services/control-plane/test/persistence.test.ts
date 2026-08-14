import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionUrl, wantSsl, startAutosave, isEmptySnapshot, type Persistence } from "@cavix/control-plane";
import type { StoreSnapshot } from "@cavix/control-plane";

// Managed Postgres closes connections routinely: maintenance, failover, an idle
// timeout, a plan change. The server sends 57P01 and `pg` emits 'error'.
//
// With a single long-lived Client and no listener, Node throws on the unhandled
// event and the process dies. That is not a degraded dashboard, it is the whole
// product's memory going away: every ledger lookup fails, every orchestrator
// claim fails, and a review posts a verdict with no idea what earlier reviews
// left open. The fix is a pool (recovers) plus a handler (never fatal).

test("sslmode is stripped when TLS is configured explicitly", () => {
  // Otherwise the URL parameter and the ssl object make competing claims about
  // TLS, and a future `pg` release decides which one wins. `pg` already warns
  // that it will read sslmode=require as verify-full, which rejects the
  // self-signed chains managed providers hand out.
  const url = connectionUrl("postgres://u:p@db.example.com:5432/cavix?sslmode=require", true);
  assert.doesNotMatch(url, /sslmode/);
  assert.match(url, /db\.example\.com/);
  assert.match(url, /\/cavix/);
});

test("other query parameters survive the strip", () => {
  const url = connectionUrl("postgres://u:p@h:5432/db?sslmode=require&application_name=cavix", true);
  assert.doesNotMatch(url, /sslmode/);
  assert.match(url, /application_name=cavix/);
});

test("a URL with no sslmode is returned untouched", () => {
  const original = "postgres://u:p@h:5432/db";
  assert.equal(connectionUrl(original, true), original);
});

test("without TLS the URL is never rewritten", () => {
  const original = "postgres://u:p@localhost:5432/db?sslmode=require";
  assert.equal(connectionUrl(original, false), original);
});

test("an unparseable connection string is handed over as-is, not mangled", () => {
  // `pg` accepts several shapes. Mangling one is worse than a deprecation
  // warning, and a broken connection string means no persistence at all.
  const odd = "host=localhost port=5432 dbname=cavix";
  assert.equal(connectionUrl(odd, true), odd);
});

test("managed hosts get TLS, localhost does not", () => {
  assert.equal(wantSsl("postgres://u:p@db.render.com:5432/cavix"), true);
  assert.equal(wantSsl("postgres://u:p@localhost:5432/cavix"), false);
  assert.equal(wantSsl("postgres://u:p@127.0.0.1:5432/cavix"), false);
  assert.equal(wantSsl("postgres://u:p@localhost:5432/cavix?sslmode=require"), true);
});

// ---------- autosave survives a database that goes away and comes back ----------

class FlakyPersistence implements Persistence {
  saved = 0;
  failNext = 0;
  errors: Error[] = [];
  async load(): Promise<StoreSnapshot | null> {
    return null;
  }
  async save(): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("terminating connection due to administrator command");
    }
    this.saved++;
  }
  async close(): Promise<void> {}
}

test("a failed save is reported and the next one still runs", async () => {
  // The autosave loop must not stop on the first dropped connection. If it did,
  // a single maintenance window would silently end persistence for the life of
  // the process, and nothing would say so until the next restart lost everything
  // since.
  let n = 0;
  const store = { snapshot: () => ({ v: 1, orgs: [{ name: `org${n++}` }] }) as unknown as StoreSnapshot };
  const p = new FlakyPersistence();
  p.failNext = 1;
  const errors: Error[] = [];

  const autosave = startAutosave(store, p, { intervalMs: 5, onError: (e) => errors.push(e) });
  await new Promise((r) => setTimeout(r, 60));
  await autosave.stop();

  assert.ok(errors.length >= 1, "the dropped connection was reported");
  assert.match(errors[0].message, /terminating connection/);
  assert.ok(p.saved >= 1, "and saving resumed afterwards");
});

test("stopping still attempts a final save, so a shutdown does not lose the last edit", async () => {
  const store = { snapshot: () => ({ v: 1, orgs: [] }) as unknown as StoreSnapshot };
  const p = new FlakyPersistence();
  const autosave = startAutosave(store, p, { intervalMs: 10_000 });
  await autosave.stop();
  assert.equal(p.saved, 1);
});

test("a final save that fails does not throw out of shutdown", async () => {
  // Shutdown runs on SIGTERM. Throwing here would skip closing the pool and
  // leave the platform to kill the process instead of it exiting cleanly.
  const store = { snapshot: () => ({ v: 1, orgs: [] }) as unknown as StoreSnapshot };
  const p = new FlakyPersistence();
  p.failNext = 1;
  const errors: Error[] = [];
  const autosave = startAutosave(store, p, { intervalMs: 10_000, onError: (e) => errors.push(e) });
  await autosave.stop();
  assert.equal(errors.length, 1);
});

// ---------- the guard that stops a workspace being wiped ----------

test("an empty state never replaces a stored workspace", () => {
  // The worst thing this file can do. The process holds state in memory and
  // writes it every few seconds. If it ever starts EMPTY while the database
  // holds a real workspace, the next tick destroys months of settings,
  // connected repositories and encrypted keys, three seconds after boot, and
  // the only symptom is a customer logging in to a site that forgot them.
  const empty = { v: 1, orgs: [], users: [] } as unknown as StoreSnapshot;
  assert.equal(isEmptySnapshot(empty), true);
});

test("a state with a workspace or a user in it is not empty", () => {
  const withOrg = { v: 1, orgs: [{ name: "acme" }], users: [] } as unknown as StoreSnapshot;
  const withUser = { v: 1, orgs: [], users: [{ id: "u1" }] } as unknown as StoreSnapshot;
  assert.equal(isEmptySnapshot(withOrg), false);
  assert.equal(isEmptySnapshot(withUser), false);
});

test("the deliberate wipe has an escape hatch", () => {
  // "The guard is wrong and I cannot get past it" is its own kind of outage.
  const previous = process.env.CAVIX_ALLOW_EMPTY_OVERWRITE;
  process.env.CAVIX_ALLOW_EMPTY_OVERWRITE = "true";
  try {
    const empty = { v: 1, orgs: [], users: [] } as unknown as StoreSnapshot;
    assert.equal(isEmptySnapshot(empty), false, "the guard stands down when asked explicitly");
  } finally {
    if (previous === undefined) delete process.env.CAVIX_ALLOW_EMPTY_OVERWRITE;
    else process.env.CAVIX_ALLOW_EMPTY_OVERWRITE = previous;
  }
});
