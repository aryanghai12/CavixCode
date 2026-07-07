import type { LLMProvider, LLMRequest, LLMResponse } from "./provider.ts";
import {
  resolveOrgConfig,
  keyFingerprint,
  type GatewayConfigData,
  type OrgConfigResolver,
  type OrgLLMConfig,
} from "./config.ts";
import { computeCostUsd, DEFAULT_PRICING, type ModelPrice } from "./cost.ts";

/** A structured, secret-free logger sink. */
export interface GatewayLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

/** Per-request cost ledger entry (Stage 13 cost accounting). */
export interface CostRecord {
  org: string;
  provider: string;
  model: string;
  /** Non-secret fingerprint of the BYOK key that was billed. */
  keyFingerprint: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  at: string;
  providerRequestId?: string;
}

/** What the caller passes per request; org config supplies model/key/limits. */
export interface GatewayCompleteInput {
  system?: string;
  messages: LLMRequest["messages"];
  /** Override the org's default model for this call (e.g. cheap triage). */
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface GatewayOptions {
  providers: Map<string, LLMProvider>;
  config: GatewayConfigData;
  pricing?: Record<string, ModelPrice>;
  logger?: GatewayLogger;
  /** Optional per-request BYOK resolver (e.g. fetch the org's key from the site). */
  resolver?: OrgConfigResolver;
  /** How long to cache a resolved org config (default 60s). */
  resolverTtlMs?: number;
}

const noopLogger: GatewayLogger = { info() {}, warn() {} };

/**
 * Gateway is the single chokepoint for every model call in Cavix. It:
 *   1. resolves the per-org BYOK key + provider + model (config over hardcode);
 *   2. routes to the chosen provider with exactly that key;
 *   3. computes and records cost, attributed to the org and key fingerprint.
 * It never logs the key. The cost ledger is queryable for accounting and tests.
 */
export class Gateway {
  private readonly providers: Map<string, LLMProvider>;
  private readonly config: GatewayConfigData;
  private readonly pricing: Record<string, ModelPrice>;
  private readonly logger: GatewayLogger;
  private readonly ledger: CostRecord[] = [];
  private readonly resolver?: OrgConfigResolver;
  private readonly resolverTtlMs: number;
  private readonly resolved = new Map<string, { cfg: OrgLLMConfig; exp: number }>();

  constructor(opts: GatewayOptions) {
    this.providers = opts.providers;
    this.config = opts.config;
    this.pricing = opts.pricing ?? DEFAULT_PRICING;
    this.logger = opts.logger ?? noopLogger;
    this.resolver = opts.resolver;
    this.resolverTtlMs = opts.resolverTtlMs ?? 60_000;
  }

  // Resolve BYOK for an org: the external resolver (the site's key store) wins, then
  // static config, then fallback. Cached briefly so one review's many calls don't
  // re-fetch, while site key changes still propagate within the TTL.
  private async resolveConfig(org: string): Promise<OrgLLMConfig> {
    const cached = this.resolved.get(org);
    if (cached && cached.exp > Date.now()) return cached.cfg;

    let cfg: OrgLLMConfig | null = null;
    if (this.resolver) {
      try {
        cfg = await this.resolver(org);
      } catch (err) {
        this.logger.warn("gateway: BYOK resolver failed, falling back to static config", { org, err: (err as Error).message });
      }
    }
    if (cfg && !cfg.apiKey) cfg = null; // resolver found the org but it has no key set yet
    const finalCfg = cfg ?? resolveOrgConfig(this.config, org); // throws if none/no key
    this.resolved.set(org, { cfg: finalCfg, exp: Date.now() + this.resolverTtlMs });
    return finalCfg;
  }

  async complete(
    org: string,
    input: GatewayCompleteInput,
  ): Promise<{ response: LLMResponse; cost: CostRecord }> {
    const orgCfg = await this.resolveConfig(org);
    const provider = this.providers.get(orgCfg.provider);
    if (!provider) {
      throw new Error(`gateway: unknown provider "${orgCfg.provider}" for org "${org}"`);
    }

    const model = input.model ?? orgCfg.model;
    const req: LLMRequest = {
      model,
      system: input.system,
      messages: input.messages,
      maxTokens: input.maxTokens ?? orgCfg.maxTokens ?? 2048,
      temperature: input.temperature,
    };

    // The BYOK key flows ONLY here, into the provider call. Not into logs.
    const response = await provider.complete(req, orgCfg.apiKey);

    const fp = keyFingerprint(orgCfg.apiKey);
    const costUsd = computeCostUsd(response.model, response.usage, this.pricing);
    if (!this.pricing[response.model]) {
      this.logger.warn("gateway: no price for model, recording cost as 0", { model: response.model });
    }
    const record: CostRecord = {
      org,
      provider: provider.name,
      model: response.model,
      keyFingerprint: fp,
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costUsd,
      at: new Date().toISOString(),
      providerRequestId: response.providerRequestId,
    };
    this.ledger.push(record);
    this.logger.info("llm call", {
      org,
      provider: provider.name,
      model: record.model,
      key_fp: fp, // fingerprint, NOT the key
      input_tokens: record.inputTokens,
      output_tokens: record.outputTokens,
      cost_usd: costUsd,
    });

    return { response, cost: record };
  }

  /** The full cost ledger, newest last. */
  costLog(): readonly CostRecord[] {
    return this.ledger;
  }

  /** Total spend across all recorded calls. */
  totalCostUsd(): number {
    return Math.round(this.ledger.reduce((s, r) => s + r.costUsd, 0) * 1e6) / 1e6;
  }
}
