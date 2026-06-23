// Embedder port for the semantic side of retrieval (Stage 7). Anthropic has no
// embeddings endpoint, so production plugs in Voyage/OpenAI/an open model here;
// the FakeEmbedder is deterministic (hash-based) so embedding-driven retrieval is
// exercised hermetically without a network call.

export interface Embedder {
  readonly dims: number;
  embed(text: string): Promise<number[]>;
}

export class FakeEmbedder implements Embedder {
  readonly dims: number;
  constructor(dims = 64) {
    this.dims = dims;
  }

  // A bag-of-tokens hashed into a fixed vector then L2-normalized. Deterministic
  // and good enough to make cosine similarity meaningful for related code.
  async embed(text: string): Promise<number[]> {
    const v = new Array<number>(this.dims).fill(0);
    for (const tok of tokenize(text)) {
      v[hash(tok) % this.dims] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length && i < b.length; i++) dot += a[i] * b[i];
  return dot; // inputs are unit vectors → dot product is cosine
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z_][a-z0-9_]+/g) ?? []).filter((t) => t.length > 2);
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
