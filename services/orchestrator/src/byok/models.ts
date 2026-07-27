// When a review fails because the workspace's saved model was retired or gated,
// "pick another model" is not much help on its own. This asks the control-plane
// which models the org's key can actually call, so the failure comment on the
// pull request can name real, working alternatives.

export interface ModelSuggesterOptions {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
}

/** Returns model ids the org can use, or [] if that cannot be determined. */
export type ModelSuggester = (org: string) => Promise<string[]>;

export function makeModelSuggester(opts: ModelSuggesterOptions): ModelSuggester {
  const base = opts.url.replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  return async (org: string): Promise<string[]> => {
    try {
      const res = await doFetch(`${base}/api/internal/orgs/${encodeURIComponent(org)}/models`, {
        headers: { authorization: `Bearer ${opts.token}` },
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { models?: Array<{ id?: string }> };
      return (data.models ?? []).map((m) => m.id).filter((id): id is string => !!id);
    } catch (err) {
      opts.logger?.warn("model suggester: fetch failed", { org, err: (err as Error).message });
      return []; // never let a diagnostic hop turn into a second failure
    }
  };
}

/**
 * Choose the best replacement when the saved model is gone.
 *
 * Ranked, not random: prefer the same family and generation the user already
 * chose (a `gemini-2.5-flash` user wants `gemini-2.5-pro`, not a 1.0 model), and
 * push preview/experimental builds to the bottom so we never auto-select
 * something less stable than what they had.
 */
export function pickBestModel(current: string, available: string[]): string | null {
  const ranked = rankModels(current, available);
  if (ranked.length === 0) return null;
  // Keeping a still-listed current choice is right when VALIDATING a selection.
  // It is wrong when REPLACING one that just failed — callers that are healing
  // must exclude the dead id first (see rankModels/healing).
  if (available.includes(current)) return current;
  return ranked[0];
}

/**
 * Rank candidates best-first for a given current model.
 *
 * Separate from pickBestModel because healing needs the whole ordered list, not
 * just the winner: a provider can list a model it will not actually serve to
 * your key, so the first candidate may fail too and we move to the next.
 */
export function rankModels(current: string, available: string[]): string[] {
  if (available.length === 0) return [];

  const cur = current.toLowerCase().replace(/^models\//, "");
  // "gemini-2.5-flash" -> ["gemini","2.5","flash"]
  const curParts = cur.split(/[-.]/).filter(Boolean);

  // Weights are ordered by what actually decides whether a review succeeds.
  // "Will this model serve me at all" beats "is it the same generation", because
  // family affinity is only a nicety while quota is the difference between a
  // review and a 429.
  const score = (id: string): number => {
    const m = id.toLowerCase();
    let s = 0;

    // 1. Same family/generation — a tiebreaker, not the deciding factor.
    const parts = m.split(/[-.]/).filter(Boolean);
    let shared = 0;
    for (let i = 0; i < Math.min(parts.length, curParts.length); i++) {
      if (parts[i] !== curParts[i]) break;
      shared++;
    }
    s += shared * 8;
    if (shared === 0) s -= 25; // a different provider's family entirely

    // 2. Tier — the dominant signal, and deliberately the OPPOSITE of "best
    //    model". The catalogue says nothing about quota, and on a free Gemini key
    //    the pro tiers are exactly the ones granted 0 requests/day, so preferring
    //    them walks straight into a 429. Flash and lite carry the free quota.
    //    Anyone who wants pro can still select it by hand.
    if (/flash|sonnet|haiku|mini/.test(m)) s += 40;
    if (/lite/.test(m)) s += 6;
    if (/\bpro\b|ultra|opus/.test(m)) s -= 40;
    if (/latest/.test(m)) s += 8;

    // 3. Hard exclusions — never auto-select these over a stable text model.
    if (/preview|exp|experimental|thinking|tuning/.test(m)) s -= 120;
    if (/embedding|vision|image|tts|audio|robotics|veo|imagen|lyria|banana|live/.test(m)) s -= 200;
    return s;
  };

  return [...available].sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}

/** Persist an auto-selected model so the next review, and the dashboard, agree. */
export function makeModelSaver(opts: ModelSuggesterOptions): (org: string, model: string) => Promise<boolean> {
  const base = opts.url.replace(/\/$/, "");
  const doFetch = opts.fetchImpl ?? fetch;
  return async (org, model) => {
    try {
      const res = await doFetch(`${base}/api/internal/orgs/${encodeURIComponent(org)}/model`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.token}`, "content-type": "application/json" },
        body: JSON.stringify({ llmModel: model }),
      });
      return res.ok;
    } catch (err) {
      opts.logger?.warn("model saver: fetch failed", { org, err: (err as Error).message });
      return false;
    }
  };
}

/** Render up to `limit` suggestions as a markdown list for a PR comment. */
export function renderSuggestions(models: string[], limit = 6): string {
  if (models.length === 0) return "";
  const shown = models.slice(0, limit);
  const more = models.length > shown.length ? `\n\n…and ${models.length - shown.length} more in the dashboard.` : "";
  return `\n\nModels your key can use right now:\n${shown.map((m) => `- \`${m}\``).join("\n")}${more}`;
}
