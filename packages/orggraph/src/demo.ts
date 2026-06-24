// Stage 5 demo — one cross-repo impact trace.  node packages/orggraph/src/demo.ts
import { OrgGraph } from "./orggraph.ts";

const OPENAPI = JSON.stringify({ openapi: "3.0.0", paths: { "/orders/{id}": { get: {}, delete: {} } } });
const CHECKOUT = `import { ordersClient } from "@acme/orders-client";
const API = "https://orders.internal";
export async function loadOrder(orderId) {
  const res = await fetch(\`\${API}/orders/\${orderId}\`);
  return ordersClient.GetOrder(orderId);
}
`;

const g = new OrgGraph();
g.ingestRepo("orders-api", [
  { path: "openapi.json", content: OPENAPI },
  { path: "proto/orders.proto", content: "package orders;\nservice OrderService { rpc GetOrder(R) returns (O); }\n" },
  { path: "package.json", content: JSON.stringify({ name: "@acme/orders-client" }) },
]);
g.ingestRepo("checkout", [{ path: "src/checkout.js", content: CHECKOUT }]);
g.ingestRepo("billing", [{ path: "src/invoice.js", content: 'const r = await fetch("https://orders.internal/orders/42");\n' }]);

console.log("Provider repo 'orders-api' exposes:");
for (const p of g.providersOf("orders-api")) console.log(`  [${p.kind}] ${p.id}`);

const diff = `diff --git a/openapi.json b/openapi.json
--- a/openapi.json
+++ b/openapi.json
@@ -1,1 +1,1 @@
-      "/orders/{id}": { "get": {} , "delete": {} }
+      "/orders/{id}": { "get": { "deprecated": true } }
`;

console.log("\nPR on orders-api changes GET /orders/{id} (breaking). Impact trace:");
for (const e of g.impactFromContractDiff("orders-api", diff)) {
  console.log(`  ${e.iface.id}  →  impacts '${e.consumerRepo}'`);
  for (const c of e.callSites) console.log(`      ${c.file}:${c.line}   ${c.snippet}`);
}
