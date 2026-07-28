import { test } from "node:test";
import assert from "node:assert/strict";
import { OrgGraph } from "@cavix/orggraph";

const OPENAPI = JSON.stringify({
  openapi: "3.0.0",
  paths: { "/orders/{id}": { get: { summary: "get" }, delete: { summary: "del" } } },
});
const PROTO = `syntax = "proto3";\npackage orders;\nservice OrderService {\n  rpc GetOrder(GetReq) returns (Order);\n}\n`;
const ORDERS_PKG = JSON.stringify({ name: "@acme/orders-client", version: "1.0.0" });

const CHECKOUT = `import { ordersClient } from "@acme/orders-client";
const API = "https://orders.internal";
export async function loadOrder(orderId) {
  const res = await fetch(\`\${API}/orders/\${orderId}\`);
  const full = await ordersClient.GetOrder(orderId);
  return { res, full };
}
`;

function buildOrg() {
  const g = new OrgGraph();
  g.ingestRepo("orders-api", [
    { path: "openapi.json", content: OPENAPI },
    { path: "proto/orders.proto", content: PROTO },
    { path: "package.json", content: ORDERS_PKG },
  ]);
  g.ingestRepo("checkout", [{ path: "src/checkout.js", content: CHECKOUT }]);
  return g;
}

test("providers: extracts HTTP endpoints, gRPC methods, and the package name", () => {
  const g = buildOrg();
  const ids = g.providersOf("orders-api").map((p) => p.id).sort();
  assert.ok(ids.includes("GET /orders/*"));
  assert.ok(ids.includes("DELETE /orders/*"));
  assert.ok(ids.includes("orders.OrderService/GetOrder"));
  assert.ok(ids.includes("@acme/orders-client"));
});

test("impact: a breaking change to GET /orders/{id} flags checkout with the exact call site", () => {
  const g = buildOrg();
  const edges = g.impactedBy(["GET /orders/*"]);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].consumerRepo, "checkout");
  assert.equal(edges[0].callSites.length, 1);
  assert.equal(edges[0].callSites[0].file, "src/checkout.js");
  assert.equal(edges[0].callSites[0].line, 4, "the fetch call line");
});

test("impact from a contract diff: changing the endpoint traces to the consumer", () => {
  const g = buildOrg();
  // PR edits the /orders/{id} path in the OpenAPI spec (a breaking change).
  const diff = `diff --git a/openapi.json b/openapi.json
--- a/openapi.json
+++ b/openapi.json
@@ -3,3 +3,3 @@
-      "/orders/{id}": { "get": { "summary": "get" } }
+      "/orders/{id}": { "get": { "summary": "get", "deprecated": true } }
`;
  const edges = g.impactFromContractDiff("orders-api", diff);
  assert.ok(edges.some((e) => e.consumerRepo === "checkout" && e.callSites[0].line === 4));
});

test("impact: gRPC method change traces to the client call site", () => {
  const g = buildOrg();
  const edges = g.impactedBy(["orders.OrderService/GetOrder"]);
  assert.equal(edges[0].consumerRepo, "checkout");
  assert.equal(edges[0].callSites[0].line, 5, "the ordersClient.GetOrder call line");
});

test("impact: a published-package change traces to the importing repo", () => {
  const g = buildOrg();
  const edges = g.impactedBy(["@acme/orders-client"]);
  assert.equal(edges[0].consumerRepo, "checkout");
  assert.equal(edges[0].callSites[0].line, 1, "the import line");
});

test("no false cross-repo edge for an unrelated interface", () => {
  const g = buildOrg();
  assert.equal(g.impactedBy(["GET /widgets/*"]).length, 0);
});

// ── the matching bugs that made this stage report nothing, or the wrong thing ──

test("a concrete call matches a templated route", () => {
  // The provider declares /orders/{id} and the caller writes /orders/abc123.
  // Comparing those as strings never matched, which is the single most common
  // shape in any real organisation, so the whole stage reported no consumers.
  const g = new OrgGraph();
  g.ingestRepo("acme/orders", [
    { path: "openapi.json", content: JSON.stringify({ openapi: "3.0.0", paths: { "/orders/{id}": { get: {} } } }) },
  ]);
  g.ingestRepo("acme/billing", [
    { path: "a.ts", content: `await fetch("https://orders.internal/api/v2/orders/abc123");` },
  ]);
  assert.equal(g.impactedBy(["GET /orders/*"]).length, 1);
});

test("a route made only of variables matches nothing, rather than everything", () => {
  const g = new OrgGraph();
  g.ingestRepo("acme/x", [
    { path: "openapi.json", content: JSON.stringify({ openapi: "3.0.0", paths: { "/{a}/{b}": { get: {} } } }) },
  ]);
  g.ingestRepo("acme/y", [{ path: "a.ts", content: `await fetch("https://any.host/totally/unrelated");` }]);
  assert.equal(g.impactedBy(["GET /*/*"]).length, 0);
});

test("removing an operation counts as changing the path that owns it", () => {
  // The path key sits above as unchanged context; only the operation line moves.
  const g = new OrgGraph();
  g.ingestRepo("acme/orders", [
    { path: "openapi.json", content: JSON.stringify({ openapi: "3.0.0", paths: { "/orders/{id}": { get: {}, delete: {} } } }) },
  ]);
  g.ingestRepo("acme/billing", [
    { path: "a.ts", content: `fetch("https://orders.internal/orders/9", { method: "DELETE" })` },
  ]);
  const diff = [
    "diff --git a/openapi.json b/openapi.json",
    "--- a/openapi.json",
    "+++ b/openapi.json",
    '@@ -3,5 +3,4 @@ "paths": {',
    '     "/orders/{id}": {',
    '       "get": {},',
    '-      "delete": {}',
    "     }",
    "",
  ].join("\n");
  const edges = g.impactFromContractDiff("acme/orders", diff);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].consumerRepo, "acme/billing");
});

test("a generic method on an unrelated client is not a consumer of anything", () => {
  // redisClient.get() and dbClient.get() were reported as callers of
  // orders.OrderService/Get, so changing one RPC told three unrelated teams
  // their code was about to break.
  const g = new OrgGraph();
  g.ingestRepo("acme/orders", [
    { path: "o.proto", content: "package orders;\nservice OrderService {\n rpc Get(R) returns (S);\n rpc CancelOrder(R) returns (S);\n}" },
  ]);
  g.ingestRepo("acme/cache", [
    { path: "c.ts", content: "await redisClient.get(k);\nawait dbClient.get(id);\nawait pgClient.query(sql);" },
  ]);
  g.ingestRepo("acme/fulfilment", [
    { path: "f.ts", content: "await ordersClient.Get(id);\nawait orderServiceClient.CancelOrder(id);" },
  ]);

  assert.deepEqual(g.impactedBy(["orders.OrderService/Get"]).map((e) => e.consumerRepo), ["acme/fulfilment"]);
  assert.deepEqual(g.impactedBy(["orders.OrderService/CancelOrder"]).map((e) => e.consumerRepo), ["acme/fulfilment"]);
});

test("repeated references collapse instead of storing one row per line", () => {
  const g = new OrgGraph();
  g.ingestRepo("acme/lib", [{ path: "package.json", content: JSON.stringify({ name: "@acme/lib" }) }]);
  g.ingestRepo("acme/app", Array.from({ length: 40 }, (_, i) => ({ path: `s/f${i}.ts`, content: `import x from "@acme/lib";` })));
  const [edge] = g.impactedBy(["@acme/lib"]);
  assert.ok(edge.callSites.length <= 8, `capped, got ${edge.callSites.length}`);
});

test("a graph survives being serialised and rebuilt", () => {
  const g = new OrgGraph();
  g.ingestRepo("acme/orders", [
    { path: "openapi.json", content: JSON.stringify({ openapi: "3.0.0", paths: { "/orders/{id}": { get: {} } } }) },
  ]);
  g.ingestRepo("acme/billing", [{ path: "a.ts", content: `fetch("https://x/orders/1")` }]);

  const back = OrgGraph.fromJSON(JSON.parse(JSON.stringify(g.toJSON())));
  assert.deepEqual(back.indexedRepos().sort(), ["acme/billing", "acme/orders"]);
  assert.equal(back.impactedBy(["GET /orders/*"]).length, 1);
});

test("rubbish in fromJSON yields an empty graph, not a crash", () => {
  for (const bad of [null, undefined, {}, { v: 2 }, "nope", 7]) {
    assert.equal(OrgGraph.fromJSON(bad).indexedRepos().length, 0);
  }
});
