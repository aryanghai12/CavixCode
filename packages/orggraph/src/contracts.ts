import { httpId, type ProvidedInterface } from "./types.ts";

// Extract the interfaces a repo PROVIDES from its contract/metadata files:
// OpenAPI (JSON), protobuf services, GraphQL SDL, and the published package name.

export interface RepoFile {
  path: string;
  content: string;
}

export function extractProviders(repo: string, file: RepoFile): ProvidedInterface[] {
  const p = file.path.toLowerCase();
  // Check specific filenames before the generic .json (package.json is also .json).
  if (p.endsWith("package.json")) return packageProviders(repo, file);
  if (p.endsWith("go.mod")) return goModProviders(repo, file);
  if (p.endsWith(".json")) return openApiProviders(repo, file);
  if (p.endsWith(".proto")) return protoProviders(repo, file);
  if (p.endsWith(".graphql") || p.endsWith(".gql")) return graphqlProviders(repo, file);
  return [];
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

function openApiProviders(repo: string, file: RepoFile): ProvidedInterface[] {
  let spec: { openapi?: string; swagger?: string; paths?: Record<string, Record<string, unknown>>; name?: string };
  try {
    spec = JSON.parse(file.content);
  } catch {
    return [];
  }
  if (!spec.paths || (!spec.openapi && !spec.swagger)) return [];
  const out: ProvidedInterface[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.has(method.toLowerCase())) {
        out.push({ repo, kind: "http", id: httpId(method, path), sourceFile: file.path });
      }
    }
  }
  return out;
}

function protoProviders(repo: string, file: RepoFile): ProvidedInterface[] {
  const pkg = /^\s*package\s+([\w.]+)\s*;/m.exec(file.content)?.[1];
  const out: ProvidedInterface[] = [];
  const svcRe = /service\s+(\w+)\s*\{([\s\S]*?)\}/g;
  let m: RegExpExecArray | null;
  while ((m = svcRe.exec(file.content)) !== null) {
    const service = m[1];
    const body = m[2];
    const rpcRe = /rpc\s+(\w+)\s*\(/g;
    let r: RegExpExecArray | null;
    while ((r = rpcRe.exec(body)) !== null) {
      const id = `${pkg ? pkg + "." : ""}${service}/${r[1]}`;
      out.push({ repo, kind: "grpc", id, sourceFile: file.path });
    }
  }
  return out;
}

function graphqlProviders(repo: string, file: RepoFile): ProvidedInterface[] {
  const out: ProvidedInterface[] = [];
  for (const root of ["Query", "Mutation", "Subscription"]) {
    const block = new RegExp(`type\\s+${root}\\s*\\{([\\s\\S]*?)\\}`).exec(file.content);
    if (!block) continue;
    for (const line of block[1].split("\n")) {
      const field = /^\s*(\w+)\s*[(:]/.exec(line)?.[1];
      if (field) out.push({ repo, kind: "graphql", id: `${root}.${field}`, sourceFile: file.path });
    }
  }
  return out;
}

function packageProviders(repo: string, file: RepoFile): ProvidedInterface[] {
  try {
    const pkg = JSON.parse(file.content) as { name?: string };
    if (pkg.name) return [{ repo, kind: "package", id: pkg.name, sourceFile: file.path }];
  } catch {
    /* ignore */
  }
  return [];
}

function goModProviders(repo: string, file: RepoFile): ProvidedInterface[] {
  const mod = /^\s*module\s+(\S+)/m.exec(file.content)?.[1];
  return mod ? [{ repo, kind: "package", id: mod, sourceFile: file.path }] : [];
}
