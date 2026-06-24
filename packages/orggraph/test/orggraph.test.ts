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
