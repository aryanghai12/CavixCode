import http from "node:http";
import { localReview, type LocalReviewOptions } from "./localReview.ts";

// A tiny local review server the IDE plugins call (localhost only). Keeps the
// engine out of the editor process and lets VS Code + JetBrains share one impl.
// Offline by default; runs in the developer's own machine/cluster.
export function createLocalReviewServer(opts: LocalReviewOptions = {}): http.Server {
  return http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok","engine":"cavix-local"}');
      return;
    }
    if (req.method === "POST" && req.url === "/review") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const { files } = JSON.parse(body || "{}") as { files?: Array<{ path: string; content: string }> };
          const result = await localReview(files ?? [], opts);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end('{"error":"not found"}');
  });
}
