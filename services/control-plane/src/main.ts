// Control-plane entrypoint:  node services/control-plane/src/main.ts
// Serves the marketing site, login, and dashboard (services/control-plane/public)
// plus the JSON API. Configure with CAVIX_CONTROL_PLANE_PORT / CAVIX_SESSION_SECRET
// / CAVIX_SECRET_KEY (see GUIDE.md §8D and SETUP_KEYS.md).
//
// Persistence: set DATABASE_URL (Postgres) and data survives restarts/redeploys.
// Without it, the store is in-memory (great for demos; cleared on restart).
import { createControlPlane } from "./server.ts";
import { InMemoryStore } from "./store.ts";
import { PostgresPersistence, startAutosave, recoveryChoice, type Autosave } from "./persistence.ts";
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
 * The store is already serving requests in memory by the time this runs, and the
 * rule when the two disagree is that THE DATABASE WINS. Whatever is stored is
 * the durable record of every workspace; whatever is in memory accumulated while
 * the site was visibly broken, showing an empty dashboard to people who then set
 * things up again. Letting that overwrite the stored copy is how a workspace
 * disappears for good.
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
      const choice = recoveryChoice(snap !== null, store.isEmpty());
      if (snap && choice === "load") {
        store.restore(snap);
        log("info", "persistence: recovered, and loaded the stored workspace", {
          attempt,
          orgs: store.listOrgs().length,
        });
      } else if (snap) {
        // THE DURABLE COPY WINS. This branch used to keep what was in memory and
        // let the next autosave tick write it over the stored snapshot, and that
        // is a data-loss bug rather than a conflict-resolution policy.
        //
        // The sequence that hurts: the database is asleep or misconfigured at
        // boot, so the site comes up looking like a brand new install. Somebody
        // signs in, finds an empty workspace, and sets it up again: connects a
        // repository, pastes an API key. Now the store is no longer empty, so
        // the emptiness guard in save() does not fire, and three seconds later a
        // workspace with one repository replaces one with months of history.
        //
        // Weighed honestly, the two outcomes are not comparable: keeping memory
        // risks destroying everything anyone has ever stored, while preferring
        // the database costs whatever was done during the outage, on a site that
        // was visibly broken at the time. So the stored snapshot is loaded and
        // what accumulated in memory is dropped, loudly.
        const before = { orgs: store.listOrgs().length };
        store.restore(snap);
        log("error", "persistence: recovered, and DISCARDED work done while the database was unreachable", {
          attempt,
          discardedOrgs: before.orgs,
          loadedOrgs: store.listOrgs().length,
          why: "anything created during the outage would otherwise have overwritten the stored workspace on the next save",
          note: "the stored workspace is intact; redo whatever was set up during the outage",
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

/**
 * Say out loud which database this process is about to talk to, and complain if
 * the secrets are the development fallbacks.
 *
 * Both of these were silent, and both produce the same bewildering symptom: you
 * sign in and your workspace is empty. Naming the host is the fastest way to
 * catch a deployment still pointed at an old database after a move, and the
 * secret check catches the other half, because CAVIX_SECRET_KEY is the key to
 * every stored BYOK key and OAuth token. Running on the built-in fallback means
 * anything saved now stops decrypting the moment a real key is set, and the
 * store reports an undecryptable blob as "no credential", so the only thing the
 * owner sees is their key and repositories quietly gone.
 *
 * The password is stripped before logging. Connection strings end up in log
 * aggregators, screenshots and support threads.
 */
function reportConfig(dbUrl: string | undefined): void {
  if (dbUrl) {
    let where = "unparseable DATABASE_URL";
    try {
      const u = new URL(dbUrl);
      where = `${u.hostname}${u.port ? ":" + u.port : ""}${u.pathname}`;
    } catch {
      /* keep the placeholder; never log the raw string */
    }
    log("info", "persistence: target database", { host: where });
  }

  const usingDefaultKey = !process.env.CAVIX_SECRET_KEY;
  const usingDefaultSession = !process.env.CAVIX_SESSION_SECRET;
  if ((usingDefaultKey || usingDefaultSession) && dbUrl) {
    log("error", "running against a real database with development secrets", {
      CAVIX_SECRET_KEY: usingDefaultKey ? "MISSING (using the public dev fallback)" : "set",
      CAVIX_SESSION_SECRET: usingDefaultSession ? "MISSING (using the public dev fallback)" : "set",
      effect:
        "stored API keys and OAuth tokens are encrypted with a key that is published in this repository, " +
        "and they will silently stop decrypting the moment a real CAVIX_SECRET_KEY is set",
      fix: "generate each once with `openssl rand -hex 32`, set them, and never change them again",
    });
  }
}

async function main(): Promise<void> {
  const store = new InMemoryStore();
  let autosave: Autosave | null = null;

  const dbUrl = process.env.DATABASE_URL ?? process.env.CAVIX_DATABASE_URL;
  reportConfig(dbUrl);
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
