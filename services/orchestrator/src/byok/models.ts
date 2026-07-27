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
  if (available.length === 0) return null;
  if (available.includes(current)) return current;

  const cur = current.toLowerCase().replace(/^models\//, "");
  // "gemini-2.5-flash" -> ["gemini","2.5","flash"]
  const curParts = cur.split(/[-.]/).filter(Boolean);

  const score = (id: string): number => {
    const m = id.toLowerCase();
    let s = 0;
    // Shared leading tokens = same family/generation as what they picked.
    const parts = m.split(/[-.]/).filter(Boolean);
    for (let i = 0; i < Math.min(parts.length, curParts.length); i++) {
      if (parts[i] !== curParts[i]) break;
      s += 30;
    }
    // Prefer capable, stable tiers.
    if (/\bpro\b|opus/.test(m)) s += 12;
    if (/latest/.test(m)) s += 8;
    if (/flash|sonnet/.test(m)) s += 6;
    // Never auto-select something experimental over a stable option.
    if (/preview|exp|experimental|beta|thinking|tuning/.test(m)) s -= 40;
    if (/lite|nano|mini|haiku|embedding|vision|image|tts|audio/.test(m)) s -= 10;
    return s;
  };

  const ranked = [...available].sort((a, b) => score(b) - score(a) || a.localeCompare(b));
  return ranked[0] ?? null;
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
