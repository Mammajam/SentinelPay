import type { PoolClient } from "@neondatabase/serverless";
import { db } from "./client.ts";
import { makeEntry, verifyChain, type AuditEntry } from "../audit/chain.ts";

/**
 * Append to the hash chain. An advisory transaction lock serializes writers so
 * two concurrent requests cannot fork the chain. Pass `client` to make the
 * audit write part of a caller's transaction.
 */
export async function appendAudit(kind: string, payload: unknown, client?: PoolClient): Promise<AuditEntry> {
  const own = client ?? (await db().connect());
  try {
    if (!client) await own.query("BEGIN");
    await own.query("SELECT pg_advisory_xact_lock(727001)");
    const { rows } = await own.query(
      "SELECT seq::int AS seq, prev_hash AS \"prevHash\", hash, kind, payload, at FROM audit_log ORDER BY seq DESC LIMIT 1",
    );
    // Hash exactly what the DB will store: jsonb drops undefined keys, so normalise first.
    const stored = JSON.parse(JSON.stringify(payload ?? null)) as unknown;
    const e = makeEntry((rows[0] as AuditEntry | undefined) ?? null, kind, stored);
    await own.query(
      "INSERT INTO audit_log (seq, prev_hash, hash, kind, payload, at) VALUES ($1,$2,$3,$4,$5,$6)",
      [e.seq, e.prevHash, e.hash, e.kind, JSON.stringify(e.payload), e.at],
    );
    if (!client) await own.query("COMMIT");
    return e;
  } catch (err) {
    if (!client) await own.query("ROLLBACK");
    throw err;
  } finally {
    if (!client) own.release();
  }
}

export async function verifyStoredChain(): Promise<number | null> {
  const { rows } = await db().query(
    "SELECT seq::int AS seq, prev_hash AS \"prevHash\", hash, kind, payload, at FROM audit_log ORDER BY seq",
  );
  return verifyChain(rows as AuditEntry[]);
}
