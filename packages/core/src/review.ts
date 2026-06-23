// ReviewJob mirrors the canonical schema the Go edge emits onto the Redis
// Stream. Field names are snake_case to match the edge's JSON byte-for-byte —
// this is the single wire contract between Stage 0 and Stage 1. If the edge's
// canonical.SchemaVersion changes, SCHEMA_VERSION here must move in lockstep.
export const SCHEMA_VERSION = "1";

export interface ReviewJob {
  schema_version: string;
  idempotency_key: string;
  delivery_id: string;
  org: string;
  repo: string; // "owner/name"
  repo_id: number;
  pr_number: number;
  action: string;
  head_sha: string;
  base_sha: string;
  installation_id: number;
  priority: number;
  title: string;
  author: string;
  enqueued_at: string;
}

/**
 * parseReviewJob validates and narrows an untrusted JSON value (read off the
 * stream) into a ReviewJob. We assert the schema version and the few fields the
 * orchestrator cannot proceed without, failing loud on skew or corruption
 * rather than letting undefined values flow into the workflow.
 */
export function parseReviewJob(value: unknown): ReviewJob {
  if (typeof value !== "object" || value === null) {
    throw new Error("review job is not an object");
  }
  const v = value as Record<string, unknown>;
  if (v.schema_version !== SCHEMA_VERSION) {
    throw new Error(
      `review job schema mismatch: got ${String(v.schema_version)}, want ${SCHEMA_VERSION}`,
    );
  }
  for (const field of ["repo", "head_sha"] as const) {
    if (typeof v[field] !== "string" || v[field] === "") {
      throw new Error(`review job missing required field: ${field}`);
    }
  }
  if (typeof v.pr_number !== "number" || v.pr_number <= 0) {
    throw new Error("review job missing required field: pr_number");
  }
  return v as unknown as ReviewJob;
}
