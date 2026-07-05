// Control-plane entrypoint:  node services/control-plane/src/main.ts
// Serves the marketing site, login, and dashboard (services/control-plane/public)
// plus the JSON API. Configure with CAVIX_CONTROL_PLANE_PORT / CAVIX_SESSION_SECRET
// / CAVIX_SECRET_KEY (see GUIDE.md §8f and SETUP_KEYS.md).
import { createControlPlane } from "./server.ts";
import { InMemoryStore } from "./store.ts";

// Honor $PORT so managed hosts (Render/Railway/Fly/Heroku) work with no extra config.
const port = Number(process.env.CAVIX_CONTROL_PLANE_PORT ?? process.env.PORT ?? "8088");
const host = process.env.CAVIX_CONTROL_PLANE_HOST ?? "0.0.0.0";
const store = new InMemoryStore();

// Seed a demo workspace so the dashboard isn't empty on first login.
// Demo credentials (dev only):  demo@cavix.dev  /  cavixdemo
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

createControlPlane(store).listen(port, host, () => {
  console.log(JSON.stringify({ level: "info", service: "control-plane", msg: "listening", host, port, url: `http://127.0.0.1:${port}` }));
});
