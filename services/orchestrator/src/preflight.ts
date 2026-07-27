// Preflight: check every external dependency ONCE, at boot, and report all of
// them together.
//
// Why this exists: each misconfiguration used to surface one at a time, on a
// pull request, after a deploy — fix, push, redeploy, discover the next one.
// Checking everything up front collapses that loop into a single log block you
// read once. It is diagnostic only: nothing here can stop the service starting.

export interface CheckResult {
  name: string;
  ok: boolean;
  /** One line a non-engineer can act on. */
  detail: string;
  /** False for things that are optional or only degrade behaviour. */
  required: boolean;
}

export interface PreflightDeps {
  /** Resolve GitHub App/token identity. */
  whoAmI?: () => Promise<{ kind: string; login: string }>;
  /** Any recorded GitHub credential problem (from GitHubAppTokenProvider). */
  githubConfigError?: string | null;
  controlPlaneUrl?: string;
  internalToken?: string;
  redisConfigured: boolean;
  providers: string[];
  fetchImpl?: typeof fetch;
}

export async function preflight(deps: PreflightDeps): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const doFetch = deps.fetchImpl ?? fetch;

  // 1. GitHub credentials — without these nothing can ever be posted.
  if (deps.githubConfigError) {
    out.push({ name: "github-auth", ok: false, required: true, detail: deps.githubConfigError });
  } else if (deps.whoAmI) {
    try {
      const id = await deps.whoAmI();
      if (id.kind === "app") {
        out.push({ name: "github-auth", ok: true, required: true, detail: `posting as ${id.login}` });
      } else if (id.kind === "user") {
        out.push({
          name: "github-auth", ok: false, required: false,
          detail: `posting as the USER "${id.login}" — reviews will carry that person's name and avatar. ` +
            "Set CAVIX_APP_ID + CAVIX_APP_PRIVATE_KEY and remove CAVIX_GITHUB_TOKEN.",
        });
      } else {
        out.push({
          name: "github-auth", ok: false, required: true,
          detail: "could not identify the GitHub credential — check CAVIX_APP_ID / CAVIX_APP_PRIVATE_KEY",
        });
      }
    } catch (err) {
      out.push({ name: "github-auth", ok: false, required: true, detail: (err as Error).message });
    }
  }

  // 2. Redis — the queue the edge feeds. Without it, no job ever arrives.
  out.push({
    name: "redis",
    ok: deps.redisConfigured,
    required: true,
    detail: deps.redisConfigured
      ? "queue configured"
      : "CAVIX_REDIS_URL is not set — the edge's jobs will never reach this service",
  });

  // 3. Control-plane — repo gating, BYOK keys and model self-heal all need it.
  if (!deps.controlPlaneUrl || !deps.internalToken) {
    out.push({
      name: "control-plane",
      ok: false,
      required: true,
      detail: "CAVIX_CONTROL_PLANE_URL and/or CAVIX_INTERNAL_TOKEN not set — " +
        "repo gating, per-org API keys, per-org review settings (verification, " +
        "pre-merge checks, blocking) and model self-heal are all disabled",
    });
  } else {
    const base = deps.controlPlaneUrl.replace(/\/$/, "");
    try {
      // A repo we do not expect to exist: a 200 proves URL + token are both good.
      const res = await doFetch(`${base}/api/internal/repos/enabled?fullName=cavix%2Fpreflight`, {
        headers: { authorization: `Bearer ${deps.internalToken}` },
      });
      if (res.ok) {
        out.push({ name: "control-plane", ok: true, required: true, detail: `reachable at ${base}` });
      } else if (res.status === 401) {
        out.push({
          name: "control-plane", ok: false, required: true,
          detail: "401 — CAVIX_INTERNAL_TOKEN differs between this service and the website",
        });
      } else if (res.status === 404) {
        out.push({
          name: "control-plane", ok: false, required: true,
          detail: "404 — the website has no CAVIX_INTERNAL_TOKEN set, so its internal API is disabled",
        });
      } else {
        out.push({ name: "control-plane", ok: false, required: true, detail: `HTTP ${res.status} from ${base}` });
      }
    } catch (err) {
      out.push({
        name: "control-plane", ok: false, required: true,
        detail: `unreachable (${(err as Error).message}). On a free host it may be asleep; reviews retry.`,
      });
    }
  }

  // 4. Providers — every provider the dashboard offers must be registered here.
  const offered = ["anthropic", "openai", "google"];
  const missing = offered.filter((p) => !deps.providers.includes(p));
  out.push({
    name: "llm-providers",
    ok: missing.length === 0,
    required: true,
    detail: missing.length === 0
      ? `registered: ${deps.providers.filter((p) => p !== "fake").join(", ")}`
      : `NOT registered: ${missing.join(", ")} — an org that picks one gets a failed review`,
  });

  return out;
}

/** Format the results as a log block that reads at a glance. */
export function formatPreflight(results: CheckResult[]): string {
  const lines = results.map((r) => {
    const mark = r.ok ? "PASS" : r.required ? "FAIL" : "WARN";
    return `  [${mark}] ${r.name.padEnd(16)} ${r.detail}`;
  });
  const failed = results.filter((r) => !r.ok && r.required).length;
  const warned = results.filter((r) => !r.ok && !r.required).length;
  const summary = failed
    ? `${failed} blocking problem${failed === 1 ? "" : "s"} — reviews will fail until fixed`
    : warned
      ? `all required checks passed, ${warned} warning${warned === 1 ? "" : "s"}`
      : "all checks passed";
  return `preflight: ${summary}\n${lines.join("\n")}`;
}
