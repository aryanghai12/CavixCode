import http from "node:http";
import type { DecisionState, Store } from "./store.ts";
import { renderDashboardHtml } from "./ui.ts";

// A small dependency-free HTTP API + dashboard over the Store. node:http keeps the
// control plane buildable in air-gapped/minimal environments (the NestJS/Next.js
// production version implements the same routes).

export function createControlPlane(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      await route(store, req, res);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  });
}

async function route(store: Store, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  const m = req.method ?? "GET";

  if (m === "GET" && p === "/healthz") return void sendJson(res, 200, { status: "ok" });

  if (m === "GET" && p === "/") {
    const reviews = store.listReviews(url.searchParams.get("org") ?? undefined);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(renderDashboardHtml(reviews));
    return;
  }

  if (m === "POST" && p === "/api/orgs") {
    const body = await readJson(req);
    if (!body.name) return void sendJson(res, 400, { error: "name required" });
    return void sendJson(res, 201, store.createOrg(String(body.name)));
  }
  if (m === "GET" && p === "/api/orgs") return void sendJson(res, 200, store.listOrgs());

  let mm = /^\/api\/orgs\/([^/]+)\/repos$/.exec(p);
  if (m === "POST" && mm) {
    const body = await readJson(req);
    if (!body.name) return void sendJson(res, 400, { error: "name required" });
    return void sendJson(res, 201, store.createRepo(decodeURIComponent(mm[1]), String(body.name)));
  }

  if (m === "POST" && p === "/api/reviews") {
    const body = await readJson(req);
    const record = store.saveReview({
      org: String(body.org),
      repo: String(body.repo),
      pr: Number(body.pr),
      title: String(body.title ?? ""),
      findings: Array.isArray(body.findings) ? body.findings : [],
    });
    return void sendJson(res, 201, record);
  }
  if (m === "GET" && p === "/api/reviews") {
    return void sendJson(res, 200, store.listReviews(url.searchParams.get("org") ?? undefined));
  }

  mm = /^\/api\/findings\/([^/]+)$/.exec(p);
  if (m === "GET" && mm) {
    const f = store.getFinding(mm[1]);
    return f ? void sendJson(res, 200, f) : void sendJson(res, 404, { error: "not found" });
  }

  mm = /^\/api\/findings\/([^/]+)\/decision$/.exec(p);
  if (m === "POST" && mm) {
    const body = await readJson(req);
    const state = body.state as DecisionState;
    if (state !== "accepted" && state !== "rejected") {
      return void sendJson(res, 400, { error: "state must be accepted|rejected" });
    }
    try {
      const updated = store.recordDecision(mm[1], state, String(body.user ?? "unknown"));
      return void sendJson(res, 200, updated);
    } catch {
      return void sendJson(res, 404, { error: "no such finding" });
    }
  }

  if (m === "GET" && p === "/api/decisions") return void sendJson(res, 200, store.listDecisions());

  sendJson(res, 404, { error: `no route for ${m} ${p}` });
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 5_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      if (!data.trim()) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, code: number, obj: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}
