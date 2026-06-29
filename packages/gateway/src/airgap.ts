import { Gateway, type GatewayLogger } from "./gateway.ts";
import { createGuardedFetch, type EgressPolicy } from "./egress.ts";
import { SelfHostedProvider } from "./providers/selfhosted.ts";
import type { GatewayConfigData } from "./config.ts";

// Build a fully air-gapped gateway: the ONLY provider is the in-cluster
// self-hosted model, reached through an EgressGuard whose allowlist contains just
// that model host. Any code path that tries to reach a cloud LLM (or any other
// external host) throws EgressBlockedError. This is the gateway half of the
// air-gap guarantee; the NetworkPolicy is the kernel half.

export interface AirgapGatewayOptions {
  /** In-cluster model endpoint, e.g. http://cavix-model.cavix.svc.cluster.local:8000 */
  modelBaseUrl: string;
  model: string;
  /** Extra hosts to permit (e.g. an in-cluster Qdrant). Model host added automatically. */
  extraAllowedHosts?: string[];
  fetchImpl?: typeof fetch;
  logger?: GatewayLogger;
}

export interface AirgapGateway {
  gateway: Gateway;
  /** The guarded fetch — reuse it for every other outbound (platforms/SCM/embeddings). */
  guardedFetch: typeof fetch;
  policy: EgressPolicy;
}

export function createAirgappedGateway(opts: AirgapGatewayOptions): AirgapGateway {
  const host = new URL(opts.modelBaseUrl).hostname;
  const policy: EgressPolicy = { allowedHosts: [host, ...(opts.extraAllowedHosts ?? [])] };
  const guardedFetch = createGuardedFetch(policy, opts.fetchImpl);

  const provider = new SelfHostedProvider({ baseUrl: opts.modelBaseUrl, fetchImpl: guardedFetch });
  const config: GatewayConfigData = {
    orgs: {},
    fallback: { provider: "selfhosted", apiKey: process.env.CAVIX_LOCAL_MODEL_TOKEN ?? "local", model: opts.model },
  };
  const gateway = new Gateway({
    providers: new Map([["selfhosted", provider]]),
    config,
    pricing: { [opts.model]: { inputPerMTok: 0, outputPerMTok: 0 } }, // local compute, no per-token cost
    logger: opts.logger,
  });
  return { gateway, guardedFetch, policy };
}
