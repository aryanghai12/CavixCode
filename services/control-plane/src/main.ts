// Control-plane entrypoint:  node services/control-plane/src/main.ts
import { createControlPlane } from "./server.ts";
import { InMemoryStore } from "./store.ts";

const port = Number(process.env.CAVIX_CONTROL_PLANE_PORT ?? "8088");
const store = new InMemoryStore();

// Seed a little data so the dashboard isn't empty on first load.
store.createOrg("acme");
store.createRepo("acme", "widget");
store.saveReview({
  org: "acme",
  repo: "widget",
  pr: 42,
  title: "Add login lookup",
  findings: [
    { path: "src/auth.js", line: 12, severity: "critical", category: "security", title: "SQL injection", body: "", source: "sast", confidence: 0.9 },
    { path: "routes.js", line: 3, severity: "high", category: "governance", title: "Endpoint missing auth check", body: "", source: "policy", confidence: 1, immutable: true },
  ],
});

createControlPlane(store).listen(port, () => {
  console.log(JSON.stringify({ level: "info", service: "control-plane", msg: "listening", port }));
});
