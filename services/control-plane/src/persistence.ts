import type { StoreSnapshot } from "./store.ts";

// Postgres persistence for the control plane: the in-memory store stays the fast,
// already-tested source of truth in the process, and we snapshot its whole state to a
// single JSONB row so data survives restarts/redeploys (free-tier disks are ephemeral).
//
// `pg` is loaded lazily through a non-literal specifier (same pattern as BullMqEngine),
// so the type checker and hermetic tests never need it. When DATABASE_URL is set in
// production, `pg` (a dependency of this package) is present and used.

const PG = "pg";

interface PgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  on(event: "error", handler: (err: Error) => void): void;
  end(): Promise<void>;
}
interface PgModule {
  Pool: new (config: unknown) => PgPool;
}

export interface Persistence {
  load(): Promise<StoreSnapshot | null>;
  save(snap: StoreSnapshot): Promise<void>;
  close(): Promise<void>;
}

export interface PostgresOptions {
  /** Where a dropped connection is reported. Never fatal. */
  onError?: (err: Error) => void;
}

/**
 * A POOL, not a single client, and an error handler that is not optional.
 *
 * This crashed the whole control plane in production, and the mechanism is worth
 * writing down because it is easy to reintroduce.
 *
 * A long-lived `pg.Client` holds one TCP connection. Managed Postgres closes
 * connections routinely: maintenance, failover, an idle timeout, a plan change.
 * When that happens the server sends `57P01 terminating connection due to
 * administrator command` and `pg` emits `'error'` on the client. An EventEmitter
 * with no `'error'` listener THROWS, and an unhandled throw at the top level
 * takes the process with it. So a perfectly ordinary database maintenance window
 * did not degrade the site; it killed it, and with it every review's ledger
 * lookup and every orchestrator claim.
 *
 * A pool fixes the recovery half: it discards a broken connection and opens a
 * new one on the next query, so a dropped connection costs one query rather than
 * the process. The `on("error")` handler fixes the fatal half, and it is
 * required even with a pool: idle clients in the pool emit errors too, and an
 * unhandled one is just as fatal as before.
 */
export class PostgresPersistence implements Persistence {
  private readonly pool: PgPool;
  private constructor(pool: PgPool) {
    this.pool = pool;
  }

  static async create(url: string, options: PostgresOptions = {}): Promise<PostgresPersistence> {
    let lib: PgModule;
    try {
      lib = (await import(PG)) as unknown as PgModule;
    } catch {
      throw new Error("Postgres persistence needs the 'pg' package (a dependency of @cavix/control-plane). Run `npm install`.");
    }
    const ssl = wantSsl(url);
    const pool = new lib.Pool({
      connectionString: connectionUrl(url, ssl),
      ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
      // Small: this pool serves one snapshot row, read at boot and written every
      // few seconds. A large pool would hold connections a managed free tier
      // counts against a low limit, for no gain.
      max: 4,
      // Below the idle timeout of every managed provider, so the pool retires a
      // connection before the server does. It is cheaper to reopen one than to
      // discover a dead one mid-write.
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    // The line whose absence killed the process.
    pool.on("error", (err) => {
      options.onError?.(err);
    });

    await pool.query(
      "CREATE TABLE IF NOT EXISTS cavix_state (id int PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())",
    );
    return new PostgresPersistence(pool);
  }

  async load(): Promise<StoreSnapshot | null> {
    const res = await this.pool.query("SELECT data FROM cavix_state WHERE id = 1");
    const row = res.rows[0];
    if (!row) return null;
    const data = row.data as unknown;
    return typeof data === "string" ? (JSON.parse(data) as StoreSnapshot) : (data as StoreSnapshot);
  }

  async save(snap: StoreSnapshot): Promise<void> {
    // Never replace a workspace with an empty one.
    //
    // This is the guard against the worst thing this file can do. The process
    // holds state in memory and writes it here every few seconds. If it ever
    // starts up EMPTY while the database holds a real workspace, the next tick
    // overwrites months of settings, connected repositories and encrypted keys
    // with nothing, three seconds after boot, and the only symptom is a customer
    // logging in to a site that has forgotten them.
    //
    // An empty store is legitimate exactly once, on a genuinely fresh database.
    // So emptiness is not refused outright, it is refused when the database
    // already holds something, which is a question worth one extra query on the
    // rare tick where the snapshot is empty at all.
    if (isEmptySnapshot(snap)) {
      const res = await this.pool.query(
        "SELECT coalesce(jsonb_array_length(data->'orgs'), 0) AS orgs, coalesce(jsonb_array_length(data->'users'), 0) AS users FROM cavix_state WHERE id = 1",
      );
      const row = res.rows[0];
      const stored = Number(row?.orgs ?? 0) + Number(row?.users ?? 0);
      if (stored > 0) {
        throw new Error(
          `refusing to overwrite ${stored} stored records with an empty state. ` +
            "The process started without loading them, so saving now would destroy them. " +
            "Restart once Postgres is reachable, or set CAVIX_ALLOW_EMPTY_OVERWRITE=true if the wipe is intended.",
        );
      }
    }
    await this.pool.query(
      "INSERT INTO cavix_state (id, data, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
      [JSON.stringify(snap)],
    );
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * The connection string, with `sslmode` removed when we supply TLS settings
 * ourselves.
 *
 * `pg` now warns that it will start reading `sslmode=require` as `verify-full`,
 * which is a stricter mode that rejects the self-signed chains managed providers
 * hand out. Leaving both in place means the explicit `ssl` object and the URL
 * parameter are making competing claims, and a future `pg` release decides which
 * one wins. Stripping it leaves exactly one statement about TLS in the code, and
 * it is the one written here.
 */
export function connectionUrl(url: string, ssl: boolean): string {
  if (!ssl) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has("sslmode")) return url;
    u.searchParams.delete("sslmode");
    return u.toString();
  } catch {
    // Not a URL we can parse. Hand it over untouched: `pg` accepts several
    // shapes, and mangling a connection string is worse than a warning.
    return url;
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

/**
 * Nothing worth keeping.
 *
 * Orgs and users, not repos or settings: those hang off an org, so a state with
 * neither an org nor a user has nobody's work in it. An escape hatch exists for
 * the deliberate wipe, because "the guard is wrong and I cannot get past it" is
 * its own kind of outage.
 */
export function isEmptySnapshot(snap: StoreSnapshot): boolean {
  if (process.env.CAVIX_ALLOW_EMPTY_OVERWRITE === "true") return false;
  return (snap.orgs?.length ?? 0) === 0 && (snap.users?.length ?? 0) === 0;
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
