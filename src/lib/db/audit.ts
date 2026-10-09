import type { PoolClient } from "@neondatabase/serverless";
import { db } from "./client.ts";
import { makeEntry, verifyChain, type AuditEntry } from "../audit/chain.ts";

/**
 * Append to the hash chain WITHOUT holding a lock across network round trips.
 *
 * Old design: BEGIN + global advisory lock + SELECT + INSERT + COMMIT (5 round trips, lock held for ~4 of
 * them), which capped the whole system at ~14 appends/s and added ~100 ms per request.
 *
 * Now: one INSERT, using the previous head cached in this process.
 *  - Safety is enforced by the DATABASE, not by us: `seq` is the PRIMARY KEY and `prev_hash` is UNIQUE,
 *    so two writers can never extend the same head; the loser gets a unique violation (23505),
 *    refreshes the head from the DB and retries.
 *  - A per-process queue serialises appends within one instance, so conflicts only occur across instances.
 *  - If the INSERT's response is lost after it committed, the retry hits a unique violation, re-reads the
 *    head and appends again: worst case a DUPLICATE audit event, never a lost or forked one.
 * Pass `client` to run inside a caller's transaction using the old locking path.
 */
let head: AuditEntry | null | undefined; // undefined = unknown, must read
let queue: Promise<unknown> = Promise.resolve();

async function readHead(): Promise<AuditEntry | null> {
  const { rows } = await db().query(
    "SELECT seq::int AS seq, prev_hash AS \"prevHash\", hash, kind, payload, at FROM audit_log ORDER BY seq DESC LIMIT 1",
  );
  return (rows[0] as AuditEntry | undefined) ?? null;
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505";

export function appendAudit(kind: string, payload: unknown, client?: PoolClient): Promise<AuditEntry> {
  if (client) return appendLocked(kind, payload, client);
  const run = queue.then(() => appendOptimistic(kind, payload));
  queue = run.catch(() => undefined); // a failure must not poison the queue
  return run;
}

async function appendOptimistic(kind: string, payload: unknown): Promise<AuditEntry> {
  // Hash exactly what the DB will store: jsonb drops undefined keys, so normalise first.
  const stored = JSON.parse(JSON.stringify(payload ?? null)) as unknown;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      if (head === undefined) head = await readHead();
      const e = makeEntry(head, kind, stored);
      await db().query(
        "INSERT INTO audit_log (seq, prev_hash, hash, kind, payload, at) VALUES ($1,$2,$3,$4,$5,$6)",
        [e.seq, e.prevHash, e.hash, e.kind, JSON.stringify(e.payload), e.at],
      );
      head = e;
      return e;
    } catch (err) {
      head = undefined; // unknown after any failure: re-read from the DB
      if (!isUniqueViolation(err)) throw err;
      await new Promise((r) => setTimeout(r, Math.random() * 15 * (attempt + 1))); // jitter against cross-instance pile-ups
    }
  }
  throw new Error("audit append contention");
}

/** Original transactional path (global advisory lock) for callers that pass their own client. */
async function appendLocked(kind: string, payload: unknown, client: PoolClient): Promise<AuditEntry> {
  await client.query("SELECT pg_advisory_xact_lock(727001)");
  const { rows } = await client.query(
    "SELECT seq::int AS seq, prev_hash AS \"prevHash\", hash, kind, payload, at FROM audit_log ORDER BY seq DESC LIMIT 1",
  );
  const stored = JSON.parse(JSON.stringify(payload ?? null)) as unknown;
  const e = makeEntry((rows[0] as AuditEntry | undefined) ?? null, kind, stored);
  await client.query(
    "INSERT INTO audit_log (seq, prev_hash, hash, kind, payload, at) VALUES ($1,$2,$3,$4,$5,$6)",
    [e.seq, e.prevHash, e.hash, e.kind, JSON.stringify(e.payload), e.at],
  );
  head = undefined;
  return e;
}

export async function verifyStoredChain(): Promise<number | null> {
  const { rows } = await db().query(
    "SELECT seq::int AS seq, prev_hash AS \"prevHash\", hash, kind, payload, at FROM audit_log ORDER BY seq",
  );
  return verifyChain(rows as AuditEntry[]);
}
