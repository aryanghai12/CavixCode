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
  store.updateSettings("acme", { llmModel: "claude-opus-4-8", policyEnabled: true });
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

async function main(): Promise<void> {
  const store = new InMemoryStore();
  let autosave: Autosave | null = null;

  const dbUrl = process.env.DATABASE_URL ?? process.env.CAVIX_DATABASE_URL;
  if (dbUrl) {
    try {
      const p = await PostgresPersistence.create(dbUrl);
      const snap = await p.load();
      if (snap) {
        store.restore(snap);
        log("info", "persistence: loaded state from Postgres", { orgs: store.listOrgs().length });
      }
      autosave = startAutosave(store, p, { onError: (e) => log("error", "autosave failed", { err: e.message }) });
      log("info", "persistence: Postgres enabled (data survives restarts)");
    } catch (e) {
      log("warn", "Postgres unavailable; using in-memory store (data will NOT survive restart)", { err: (e as Error).message });
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
}

main().catch((err) => {
  log("error", "fatal", { err: (err as Error).message });
  process.exit(1);
});
