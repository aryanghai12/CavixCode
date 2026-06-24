import { httpId, type ConsumerRef } from "./types.ts";
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
const GRPC_CALL = /\b(\w*[Cc]lient|stub)\.(\w+)\s*\(/;

function grpcRefs(file: string, line: string, ln: number, out: ConsumerRef[]): void {
  const m = GRPC_CALL.exec(line);
  if (!m) return;
  out.push({ kind: "grpc", key: m[2].toLowerCase(), file, line: ln, snippet: line.trim().slice(0, 120) });
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
