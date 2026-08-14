import { test } from "node:test";
import assert from "node:assert/strict";
import { CodeIndex, HeuristicParser } from "@cavix/analyzer";

// Routes are the one edge kind that changes what a review can SAY rather than
// how much it can see.
//
// A scanner reports "string-built query". A reviewer that knows the routes
// reports "an unauthenticated POST reaches a string-built query". Those two
// sentences get very different responses from the person reading them, and only
// the second is worth interrupting somebody for.

const index = (files: Array<{ path: string; content: string }>) => {
  const ix = new CodeIndex(new HeuristicParser());
  ix.indexFiles(files);
  return ix;
};

test("express-style routes are found, with their verb and path", () => {
  const ix = index([
    {
      path: "src/server.ts",
      content: `export function mount(app) {
  app.get("/api/orders", listOrders);
  app.post("/api/refunds/:id", createRefund);
}
`,
    },
  ]);
  const routes = ix.allRoutes();
  assert.equal(routes.length, 2);
  assert.deepEqual(
    routes.map((r) => `${r.method} ${r.route}`).sort(),
    ["GET /api/orders", "POST /api/refunds/:id"],
  );
});

test("the shapes other frameworks write are recognised too", () => {
  // Framework-agnostic on purpose: it matches the SHAPE of a route declaration,
  // so a framework nobody here has heard of still registers.
  const ix = index([
    { path: "a.ts", content: 'export function m(r) {\n  r.Delete("/v1/keys/:id", drop);\n}\n' },
    { path: "b.go", content: 'func mount(mux *http.ServeMux) {\n  mux.HandleFunc("/healthz", health)\n}\n' },
    { path: "c.py", content: '@app.post("/charge")\ndef charge():\n    return 1\n' },
  ]);
  const routes = ix.allRoutes().map((r) => `${r.method} ${r.route}`).sort();
  assert.deepEqual(routes, ["ANY /healthz", "DELETE /v1/keys/:id", "POST /charge"]);
});

test("a flask route reports the method it declares", () => {
  const ix = index([
    { path: "app.py", content: '@app.route("/pay", methods=["POST"])\ndef pay():\n    return 1\n' },
  ]);
  assert.equal(ix.allRoutes()[0].method, "POST");
});

test("a string that is not a path is not a route", () => {
  // Both a verb and a leading slash are required. Without that, every
  // `logger.get("name")` in a repository becomes an HTTP endpoint.
  const ix = index([
    { path: "a.ts", content: 'export function f() {\n  cache.get("user:42");\n  config.post("something");\n}\n' },
  ]);
  assert.deepEqual(ix.allRoutes(), []);
});

test("a file with no routes contributes none", () => {
  const ix = index([{ path: "a.ts", content: "export function pure(x) { return x + 1; }\n" }]);
  assert.deepEqual(ix.allRoutes(), []);
});

// ---------- reachability ----------

const APP = [
  {
    path: "src/routes.ts",
    content: `import { refund } from "./refund";
export function mount(app) {
  app.post("/api/refunds/:id", (req, res) => refund(req.params.id));
}
`,
  },
  {
    path: "src/refund.ts",
    content: `import { query } from "./db";
export function refund(id) {
  return query(id);
}
`,
  },
  { path: "src/db.ts", content: "export function query(sql) { return sql; }\n" },
  { path: "src/cron.ts", content: "export function nightly() { return 1; }\n" },
];

test("a route that reaches the changed code is reported", () => {
  const ix = index(APP);
  const reaching = ix.routesReaching(["src/db.ts#query"]);
  assert.equal(reaching.length, 1);
  assert.equal(reaching[0].method, "POST");
  assert.equal(reaching[0].route, "/api/refunds/:id");
});

test("a route that cannot reach the changed code is not reported", () => {
  // The point of the sentence is that it is a measurement. A route attached to
  // unrelated code would make it a decoration.
  const ix = index(APP);
  assert.deepEqual(ix.routesReaching(["src/cron.ts#nightly"]), []);
});

test("the declaring symbol itself counts as reached", () => {
  const ix = index(APP);
  const reaching = ix.routesReaching(["src/routes.ts#mount"]);
  assert.equal(reaching.length, 1);
});

test("a route this parser could not attribute to a symbol is left out, not guessed at", () => {
  // Top-level route registration with no enclosing function. Attaching it to a
  // guess would put an invented claim about security on a pull request.
  const ix = index([
    { path: "src/top.ts", content: 'app.get("/loose", handler);\n' },
    { path: "src/db.ts", content: "export function query(sql) { return sql; }\n" },
  ]);
  assert.equal(ix.allRoutes().length, 1, "it is still known");
  assert.deepEqual(ix.routesReaching(["src/db.ts#query"]), [], "but never attributed");
});

test("an auth mention on the declaring line is recorded as a hint, and only a hint", () => {
  // Middleware applied elsewhere is invisible to a line parser, so this can only
  // ever say "this line mentions auth". Reading the ABSENCE of it as "this route
  // is unprotected" would be guessing about security.
  const ix = index([
    {
      path: "src/routes.ts",
      content: `export function mount(app) {
  app.post("/admin/keys", requireAuth, createKey);
  app.get("/public/status", status);
}
`,
    },
  ]);
  const byRoute = Object.fromEntries(ix.allRoutes().map((r) => [r.route, r.guarded]));
  assert.equal(byRoute["/admin/keys"], true);
  assert.equal(byRoute["/public/status"], false);
});
