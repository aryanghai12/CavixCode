import type { StoreSnapshot } from "./store.ts";

// Postgres persistence for the control plane: the in-memory store stays the fast,
// already-tested source of truth in the process, and we snapshot its whole state to a
// single JSONB row so data survives restarts/redeploys (free-tier disks are ephemeral).
//
// `pg` is loaded lazily through a non-literal specifier (same pattern as BullMqEngine),
// so the type checker and hermetic tests never need it. When DATABASE_URL is set in
// production, `pg` (a dependency of this package) is present and used.

const PG = "pg";

interface PgClient {
  connect(): Promise<void>;
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
}
interface PgModule {
  Client: new (config: unknown) => PgClient;
}

export interface Persistence {
  load(): Promise<StoreSnapshot | null>;
  save(snap: StoreSnapshot): Promise<void>;
  close(): Promise<void>;
}

export class PostgresPersistence implements Persistence {
  private readonly client: PgClient;
  private constructor(client: PgClient) {
    this.client = client;
  }

  static async create(url: string): Promise<PostgresPersistence> {
    let lib: PgModule;
    try {
      lib = (await import(PG)) as unknown as PgModule;
    } catch {
      throw new Error("Postgres persistence needs the 'pg' package (a dependency of @cavix/control-plane). Run `npm install`.");
    }
    const ssl = wantSsl(url);
    const client = new lib.Client({ connectionString: url, ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}) });
    await client.connect();
    await client.query(
      "CREATE TABLE IF NOT EXISTS cavix_state (id int PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())",
    );
    return new PostgresPersistence(client);
  }

  async load(): Promise<StoreSnapshot | null> {
    const res = await this.client.query("SELECT data FROM cavix_state WHERE id = 1");
    const row = res.rows[0];
    if (!row) return null;
    const data = row.data as unknown;
    return typeof data === "string" ? (JSON.parse(data) as StoreSnapshot) : (data as StoreSnapshot);
  }

  async save(snap: StoreSnapshot): Promise<void> {
    await this.client.query(
      "INSERT INTO cavix_state (id, data, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
      [JSON.stringify(snap)],
    );
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

/** Managed Postgres (Render/Neon/Supabase) needs TLS; localhost dev usually doesn't. */
export function wantSsl(url: string): boolean {
  if (process.env.CAVIX_DATABASE_SSL === "off") return false;
  if (process.env.CAVIX_DATABASE_SSL === "true") return true;
  if (/sslmode=require/i.test(url)) return true;
  try {
    const host = new URL(url).hostname;
    return host !== "localhost" && host !== "127.0.0.1";
  } catch {
    return false;
  }
}

export interface Autosave {
  stop(): Promise<void>;
}

/** Periodically persist the store's snapshot (only when it changed) + a final save on stop. */
export function startAutosave(
  store: { snapshot(): StoreSnapshot },
  p: Persistence,
  opts: { intervalMs?: number; onError?: (e: Error) => void } = {},
): Autosave {
  const intervalMs = opts.intervalMs ?? 3000;
  let last = "";
  let saving = false;
  const tick = async () => {
    if (saving) return;
    const json = JSON.stringify(store.snapshot());
    if (json === last) return;
    saving = true;
    try {
      await p.save(JSON.parse(json) as StoreSnapshot);
      last = json;
    } catch (e) {
      opts.onError?.(e as Error);
    } finally {
      saving = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  if (typeof (timer as { unref?: () => void }).unref === "function") (timer as { unref: () => void }).unref();
  return {
    stop: async () => {
      clearInterval(timer);
      try {
        await p.save(store.snapshot());
      } catch (e) {
        opts.onError?.(e as Error);
      }
      await p.close();
    },
  };
}
