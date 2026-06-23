import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeIndex, HeuristicParser } from "@cavix/analyzer";
import { PolicyEngine, POLICY_OFF, type OrgPolicyConfig } from "@cavix/policy";

const ROUTES_NO_AUTH = `const app = require("express")();
app.get("/orders", (req, res) => {
  const data = db.orders.find();
  return res.json(data);
});
`;

const ROUTES_WITH_AUTH = `const app = require("express")();
const { requireAuth } = require("./auth");
app.get("/orders", (req, res) => {
  if (!requireAuth(req)) return res.status(401).end();
  return res.json(db.orders.find());
});
`;

const FLASK_NO_AUTH = `from flask import Flask
app = Flask(__name__)

@app.route("/orders")
def orders():
    return db.orders.all()
`;

function engine() {
  return new PolicyEngine();
}

test("gate OFF (default): returns nothing even with violations present", () => {
  const findings = engine().evaluate({ files: [{ path: "routes.js", content: ROUTES_NO_AUTH }] }, POLICY_OFF);
  assert.equal(findings.length, 0);
});

test("gate ON: flags an express endpoint missing an auth check", () => {
  const config: OrgPolicyConfig = { enabled: true, rules: { "endpoint-needs-auth": { enabled: true } } };
  const findings = engine().evaluate({ files: [{ path: "routes.js", content: ROUTES_NO_AUTH }] }, config);
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.source, "policy");
  assert.equal(f.immutable, true);
  assert.equal(f.confidence, 1);
  assert.equal(f.ruleId, "policy/endpoint-needs-auth");
});

test("gate ON: endpoint WITH an auth check (cross-file import) is not flagged", () => {
  const config: OrgPolicyConfig = { enabled: true, rules: { "endpoint-needs-auth": { enabled: true } } };
  const findings = engine().evaluate({ files: [{ path: "routes.js", content: ROUTES_WITH_AUTH }] }, config);
  assert.equal(findings.length, 0);
});

test("gate ON: flask endpoint without auth is flagged", () => {
  const config: OrgPolicyConfig = { enabled: true, rules: { "endpoint-needs-auth": { enabled: true } } };
  const findings = engine().evaluate({ files: [{ path: "app.py", content: FLASK_NO_AUTH }] }, config);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].path, "app.py");
});

test("gate ON: named handler defined cross-file with no auth is flagged via the graph", () => {
  const handlers = `export function listOrders(req, res) {\n  return res.json(db.orders.find());\n}\n`;
  const routes = `import { listOrders } from "./handlers";\napp.get("/orders", listOrders);\n`;
  const idx = new CodeIndex(new HeuristicParser());
  idx.indexFiles([
    { path: "handlers.js", content: handlers },
    { path: "routes.js", content: routes },
  ]);
  const config: OrgPolicyConfig = { enabled: true, rules: { "endpoint-needs-auth": { enabled: true } } };
  const findings = engine().evaluate(
    { files: [{ path: "handlers.js", content: handlers }, { path: "routes.js", content: routes }], index: idx },
    config,
  );
  assert.equal(findings.length, 1, "named cross-file handler without auth should be flagged");
  assert.equal(findings[0].path, "routes.js");
});

test("gate ON: generic banned-import rule (non-security governance)", () => {
  const config: OrgPolicyConfig = {
    enabled: true,
    rules: { "banned-import": { enabled: true, options: { modules: ["moment", "../legacy/db"] } } },
  };
  const file = { path: "x.js", content: 'import moment from "moment";\nconst ok = require("lodash");\n' };
  const findings = engine().evaluate({ files: [file] }, config);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].ruleId, "policy/banned-import");
  assert.match(findings[0].body, /moment/);
});

test("only explicitly enabled rules run", () => {
  const config: OrgPolicyConfig = { enabled: true, rules: { "banned-import": { enabled: false } } };
  const findings = engine().evaluate({ files: [{ path: "routes.js", content: ROUTES_NO_AUTH }] }, config);
  assert.equal(findings.length, 0, "endpoint rule not enabled → no findings");
});
