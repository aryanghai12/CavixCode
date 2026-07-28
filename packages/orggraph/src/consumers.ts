import { httpId, nameTokens, type ConsumerRef } from "./types.ts";
import type { RepoFile } from "./contracts.ts";

// Extract the interfaces a repo CONSUMES, with exact call sites: outbound HTTP
// calls, gRPC client calls, and package imports. Heuristic and language-tolerant
// — a missed reference just means a missed edge, never a wrong one.

export function extractConsumerRefs(file: RepoFile): ConsumerRef[] {
  const out: ConsumerRef[] = [];
  const lines = file.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ln = i + 1;
    httpRefs(file.path, line, ln, out);
    grpcRefs(file.path, line, ln, out);
    importRefs(file.path, line, ln, out);
  }
  return out;
}

// fetch("…/path"), axios.get("…"), got.delete("…"), http.get('/path'), requests.get(...)
const HTTP_CALL = /\b(?:fetch|axios|got|request|requests|http|https|client)\s*\.?\s*(get|post|put|patch|delete)?\s*\(\s*([`'"])([^`'"]*?)\2/i;

function httpRefs(file: string, line: string, ln: number, out: ConsumerRef[]): void {
  const m = HTTP_CALL.exec(line);
  if (!m) return;
  const url = m[3];
  if (!url.includes("/")) return; // not a path
  // Method: explicit verb on the call, or method:'X' on the line, else GET.
  const explicit = m[1];
  const methodOpt = /method\s*:\s*['"](\w+)['"]/i.exec(line)?.[1];
  const method = (explicit || methodOpt || "get").toUpperCase();
  out.push({ kind: "http", key: httpId(method, url), file, line: ln, snippet: line.trim().slice(0, 120) });
}

// someClient.Method(  |  stub.Method(  |  ordersClient.Get(
const GRPC_CALL = /\b(\w*[Cc]lient|\w*[Ss]tub)\.(\w+)\s*\(/;

/**
 * Method names so common that seeing one proves nothing about which service was
 * called. `redisClient.get()` and `orderClient.get()` are the same shape; only
 * the receiver tells them apart, so a call whose receiver carries no service
 * name is not recorded at all rather than recorded as a guess.
 */
const GENERIC_METHODS = new Set([
  "get", "set", "put", "del", "delete", "add", "has", "list", "query", "exec", "execute",
  "run", "send", "call", "invoke", "close", "end", "connect", "disconnect", "on", "off",
  "emit", "once", "read", "write", "open", "start", "stop", "init", "load", "save",
  "fetch", "request", "do", "next", "then", "catch", "map", "keys", "values",
]);

function grpcRefs(file: string, line: string, ln: number, out: ConsumerRef[]): void {
  const m = GRPC_CALL.exec(line);
  if (!m) return;
  const scope = nameTokens(m[1]);
  const method = m[2].toLowerCase();
  // A bare `stub.Get()` or `client.get()` names nothing and the method is a word
  // every library uses. Recording it would manufacture an edge, and a wrong edge
  // on a pull request costs more than a missed one.
  if (scope.length === 0 && GENERIC_METHODS.has(method)) return;
  out.push({ kind: "grpc", key: method, file, line: ln, snippet: line.trim().slice(0, 120), scope });
}

function importRefs(file: string, line: string, ln: number, out: ConsumerRef[]): void {
  let mod: string | null = null;
  let m = /^\s*import\s+(?:[^"']*\s+from\s+)?["']([^"']+)["']/.exec(line);
  if (m) mod = m[1];
  if (!mod) {
    m = /\brequire\(\s*["']([^"']+)["']\s*\)/.exec(line);
    if (m) mod = m[1];
  }
  if (!mod) return;
  // Only cross-repo packages matter (skip relative imports).
  if (mod.startsWith(".") || mod.startsWith("/")) return;
  out.push({ kind: "package", key: mod, file, line: ln, snippet: line.trim().slice(0, 120) });
}
