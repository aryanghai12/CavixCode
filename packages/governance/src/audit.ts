import { createHash } from "node:crypto";

// Tamper-evident audit log: each entry's hash chains the previous one, so any
// edit/insertion/deletion breaks the chain from that point on. This is the
// append-only audit trail enterprises (and SOC 2 / ISO 27001) require. In
// production entries are also persisted (append-only WORM storage); the chain
// makes the storage's integrity independently verifiable.

export interface AuditEntry {
  seq: number;
  at: string;
  actor: string;
  action: string;
  target: string;
  meta: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

function entryHash(e: Omit<AuditEntry, "hash">): string {
  const canonical = JSON.stringify([e.seq, e.at, e.actor, e.action, e.target, e.meta, e.prevHash]);
  return createHash("sha256").update(canonical).digest("hex");
}

export class AuditLog {
  private entries: AuditEntry[] = [];
  private readonly clock: () => string;

  constructor(clock: () => string = () => new Date().toISOString()) {
    this.clock = clock;
  }

  append(actor: string, action: string, target: string, meta: Record<string, unknown> = {}): AuditEntry {
    const prevHash = this.entries.length ? this.entries[this.entries.length - 1].hash : GENESIS;
    const base = { seq: this.entries.length, at: this.clock(), actor, action, target, meta, prevHash };
    const entry: AuditEntry = { ...base, hash: entryHash(base) };
    this.entries.push(entry);
    return entry;
  }

  list(): readonly AuditEntry[] {
    return this.entries;
  }

  /** Recompute the chain; returns the first tampered seq, or null if intact. */
  verify(): { ok: boolean; brokenAt: number | null } {
    let prev = GENESIS;
    for (const e of this.entries) {
      const expected = entryHash({ seq: e.seq, at: e.at, actor: e.actor, action: e.action, target: e.target, meta: e.meta, prevHash: prev });
      if (e.prevHash !== prev || e.hash !== expected) return { ok: false, brokenAt: e.seq };
      prev = e.hash;
    }
    return { ok: true, brokenAt: null };
  }
}
