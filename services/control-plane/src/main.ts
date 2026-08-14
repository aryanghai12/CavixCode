// Control-plane entrypoint:  node services/control-plane/src/main.ts
// Serves the marketing site, login, and dashboard (services/control-plane/public)
// plus the JSON API. Configure with CAVIX_CONTROL_PLANE_PORT / CAVIX_SESSION_SECRET
// / CAVIX_SECRET_KEY (see GUIDE.md §8D and SETUP_KEYS.md).
//
// Persistence: set DATABASE_URL (Postgres) and data survives restarts/redeploys.
// Without it, the store is in-memory (great for demos; cleared on restart).
import { createControlPlane } from "./server.ts";
import { InMemoryStore } from "./store.ts";
import { PostgresPersistence, startAutosave, type Autosave } from "./persistence.ts";
import { demoEnabled } from "./github.ts";

function log(level: string, msg: string, meta?: Record<string, unknown>): void {
  console.log(JSON.stringify({ level, service: "control-plane", msg, ...meta }));
}

// Honor $PORT so managed hosts (Render/Railway/Fly/Heroku) work with no extra config.
const port = Number(process.env.CAVIX_CONTROL_PLANE_PORT ?? process.env.PORT ?? "8088");
const host = process.env.CAVIX_CONTROL_PLANE_HOST ?? "0.0.0.0";

// Seed a demo workspace so the dashboard isn't empty on first run.
// Demo credentials (dev only):  demo@cavix.dev  /  cavixdemo
function seedDemo(store: InMemoryStore): void {
  store.createOrg("acme", { tier: "paid", provenFeedOptIn: true });
  store.createUser({ email: "demo@cavix.dev", name: "Demo Owner", password: "cavixdemo", org: "acme", role: "owner" });
  store.createUser({ email: "reviewer@cavix.dev", name: "Riya Reviewer", password: "cavixdemo", org: "acme", role: "reviewer" });
  store.setApiKey("acme", "sk-ant-demo-0000000000000000000000000000demo");
  store.updateSettings("acme", { llmModel: "claude-opus-5", policyEnabled: true });
  store.createRepo("acme", "widget", { visibility: "private" });
  store.createRepo("acme", "payments-api", { visibility: "private" });
  store.saveReview({
    org: "acme", repo: "widget", pr: 42, title: "Add login lookup",
    findings: [
      { path: "src/auth.js", line: 12, severity: "critical", category: "security", title: "SQL injection in user lookup", body: "", source: "sast", confidence: 0.9, verified: true },
      { path: "routes.js", line: 3, severity: "high", category: "governance", title: "Endpoint missing auth check", body: "", source: "policy", confidence: 1, immutable: true },
    ],
  });
  store.saveReview({
    org: "acme", repo: "payments-api", pr: 108, title: "Refactor refund flow",
    findings: [
      { path: "src/refund.ts", line: 88, severity: "high", category: "correctness", title: "Refund can double-apply on retry", body: "", source: "llm", confidence: 0.86, agent: "correctness", verified: true },
      { path: "src/refund.ts", line: 5, severity: "low", category: "standards", title: "Prefer const over let", body: "", source: "llm", confidence: 0.5, agent: "standards" },
    ],
  });
}

/**
 * Keep trying to reach Postgres, and adopt it the moment it answers.
 *
 * The store is already serving requests in memory by the time this runs, so the
 * ordering matters: LOAD first and only merge in what the database holds if this
 * process has not yet been given anything of its own. A process that has taken
 * real work since booting must not have it replaced by an older snapshot, and a
 * process that has taken none must not overwrite the database with its emptiness.
 * `save` refuses the second case outright; this handles the first.
 */
async function retryPersistence(
  dbUrl: string,
  store: InMemoryStore,
  onReady: (autosave: Autosave) => void,
): Promise<void> {
  for (let attempt = 1; attempt <= PERSISTENCE_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, Math.min(30_000, 2_000 * attempt)));
    try {
      const p = await PostgresPersistence.create(dbUrl, {
        onError: (e) => log("warn", "Postgres dropped a connection; the pool will reopen", { err: e.message }),
      });
      const snap = await p.load();
      if (snap && store.isEmpty()) {
        store.restore(snap);
        log("info", "persistence: recovered, and loaded the stored workspace", {
          attempt,
          orgs: store.listOrgs().length,
        });
      } else if (snap) {
        // Somebody signed up or connected a repository while the database was
        // unreachable. Their work is in memory and the snapshot is older, so
        // restoring would throw away the newer of the two.
        log("warn", "persistence: recovered, but this process already holds newer state; keeping it", {
          attempt,
          note: "the stored snapshot was NOT loaded, and will be replaced by what is in memory",
        });
      } else {
        log("info", "persistence: recovered (the database holds nothing yet)", { attempt });
      }
      onReady(startAutosave(store, p, { onError: (e) => log("error", "autosave failed", { err: e.message }) }));
      log("info", "persistence: Postgres enabled (data survives restarts)");
      return;
    } catch (e) {
      log("warn", "Postgres still unreachable", { attempt, err: (e as Error).message });
    }
  }
  log("error", "gave up reaching Postgres; this process is not saving anything", {
    attempts: PERSISTENCE_ATTEMPTS,
    fix: "check DATABASE_URL and that the database is awake, then redeploy",
  });
}

/** Roughly ten minutes of trying, which outlasts any cold start worth waiting for. */
const PERSISTENCE_ATTEMPTS = 30;

async function main(): Promise<void> {
  const store = new InMemoryStore();
  let autosave: Autosave | null = null;

  const dbUrl = process.env.DATABASE_URL ?? process.env.CAVIX_DATABASE_URL;
  if (dbUrl) {
    try {
      const p = await PostgresPersistence.create(dbUrl, {
        // A dropped connection is an event, not a catastrophe. Managed Postgres
        // closes connections routinely (maintenance, failover, idle timeouts),
        // and this used to take the whole process down with it: the site went
        // dark, every ledger lookup failed, and every orchestrator claim with
        // them. The pool reopens on the next query; this line is what keeps the
        // report from being fatal.
        onError: (e) =>
          log("warn", "Postgres dropped a connection; the pool will reopen on the next write", {
            err: e.message,
          }),
      });
      const snap = await p.load();
      if (snap) {
        store.restore(snap);
        log("info", "persistence: loaded state from Postgres", { orgs: store.listOrgs().length });
      }
      autosave = startAutosave(store, p, { onError: (e) => log("error", "autosave failed", { err: e.message }) });
      log("info", "persistence: Postgres enabled (data survives restarts)");
    } catch (e) {
      // Giving up here is what cost somebody their workspace.
      //
      // Serverless Postgres suspends when idle (Neon does after minutes) and
      // free hosting spins down, so a boot that lands while the database is
      // asleep hits a timeout. The old code logged a warning and ran in memory
      // FOREVER: the site came up looking perfectly normal and completely empty,
      // the customer set everything up again, nothing was persisting, and the
      // next restart lost it a second time.
      //
      // The data was never gone. Nothing could reach it, and nothing tried again.
      log("error", "Postgres could not be reached at startup; retrying in the background", {
        err: (e as Error).message,
        effect: "the site is running WITHOUT persistence and may look empty; nothing is being saved yet",
        note: "existing data is still in the database, not lost",
      });
      void retryPersistence(dbUrl, store, (a) => {
        autosave = a;
      });
    }
  } else {
    log("info", "persistence: in-memory (set DATABASE_URL for a Postgres that survives restarts)");
  }

  // Demo data is for local dev only. In production (DATABASE_URL / RENDER) the site
  // starts EMPTY and uses real sign-up + real GitHub OAuth. Force with CAVIX_DEMO.
  if (store.isEmpty() && demoEnabled()) {
    seedDemo(store);
    log("info", "seeded demo workspace (demo@cavix.dev / cavixdemo) — set CAVIX_DEMO=false to disable");
  } else if (store.isEmpty()) {
    log("info", "production mode: empty store, real auth (set CAVIX_DEMO=true for sample data)");
  }

  const server = createControlPlane(store).listen(port, host, () => {
    log("info", "listening", { host, port, url: `http://127.0.0.1:${port}` });
  });

  const shutdown = async () => {
    log("info", "shutting down");
    if (autosave) await autosave.stop(); // final save + close DB
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Stay up.
  //
  // This process is the whole product's memory. When it dies, the site goes
  // dark, every review's ledger lookup fails, and every orchestrator claim with
  // it, so a review posts a verdict with no idea what earlier reviews left open.
  // A dropped database socket already did exactly that once: `pg` emitted an
  // unhandled `'error'` and Node took the process with it.
  //
  // The specific cause is fixed at its source (a pool, with a handler). This is
  // the net under it, and the trade is deliberate: continuing after an unexpected
  // error risks acting on odd state, while exiting guarantees downtime for
  // everything. For a process whose durable state is a snapshot it re-reads at
  // boot, staying up is the better bet. Both are logged at error level with the
  // stack, so neither hides.
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    log("error", "unhandled promise rejection (continuing)", { err: err.message, stack: err.stack });
  });
  process.on("uncaughtException", (err) => {
    log("error", "uncaught exception (continuing)", { err: err.message, stack: err.stack });
  });
}

main().catch((err) => {
  log("error", "fatal", { err: (err as Error).message });
  process.exit(1);
});
