import type { PoolClient } from "@neondatabase/serverless";
import { db } from "./client.ts";
import { makeEntry, verifyChain, type AuditEntry } from "../audit/chain.ts";

/**
 * Append to the hash chain WITHOUT holding a lock across network round trips, using GROUP COMMIT.
 *
 * History (measured on Cloud Run, ~24 ms per DB round trip):
 *  v1  BEGIN + global advisory lock + SELECT + INSERT + COMMIT: 5 round trips, lock held for ~4 => ~14 appends/s system-wide.
 *  v2  one INSERT per append, serialised in-process: 1 round trip each => ~40 appends/s per instance; under
 *      concurrency each request waited behind all the others (25 concurrent => ~600 ms).
 *  v3  (this) group commit: every append that arrives while an INSERT is in flight joins the NEXT batch, which is
 *      chained in memory and written as ONE multi-row INSERT. N concurrent appends cost one round trip.
 *
 * Safety is enforced by the DATABASE, not by us: `seq` is the PRIMARY KEY and `prev_hash` is UNIQUE, so two
 * writers (or two instances) can never extend the same head. The loser's whole statement fails atomically with a
 * unique violation (23505); it re-reads the head and retries the batch. If a response is lost after a commit,
 * the retry's unique violation triggers a re-read and re-append: worst case a DUPLICATE audit event, never a
 * lost or forked one. Pass `client` to run inside a caller's transaction using the old locking path.
 */
let head: AuditEntry | null | undefined; // undefined = unknown, must read from the DB
interface Pending { kind: string; stored: unknown; resolve: (e: AuditEntry) => void; reject: (e: unknown) => void }
const pending: Pending[] = [];
let flushing = false;
const MAX_BATCH = 50;

async function readHead(): Promise<AuditEntry | null> {
  const { rows } = await db().query(
    "SELECT seq::int AS seq, prev_hash AS \"prevHash\", hash, kind, payload, at FROM audit_log ORDER BY seq DESC LIMIT 1",
  );
  return (rows[0] as AuditEntry | undefined) ?? null;
}

const isUniqueViolation = (e: unknown) => (e as { code?: string })?.code === "23505";

/** One multi-row INSERT for a chained batch. Exported for tests. */
export function buildBatchInsert(entries: AuditEntry[]) {
  const text = `INSERT INTO audit_log (seq, prev_hash, hash, kind, payload, at) VALUES ${entries
    .map((_, i) => `($${i * 6 + 1},$${i * 6 + 2},$${i * 6 + 3},$${i * 6 + 4},$${i * 6 + 5},$${i * 6 + 6})`)
    .join(",")}`;
  const params = entries.flatMap((e) => [e.seq, e.prevHash, e.hash, e.kind, JSON.stringify(e.payload), e.at]);
  return { text, params };
}

export function appendAudit(kind: string, payload: unknown, client?: PoolClient): Promise<AuditEntry> {
  if (client) return appendLocked(kind, payload, client);
  // Hash exactly what the DB will store: jsonb drops undefined keys, so normalise first.
  const stored = JSON.parse(JSON.stringify(payload ?? null)) as unknown;
  return new Promise<AuditEntry>((resolve, reject) => {
    pending.push({ kind, stored, resolve, reject });
    void flush();
  });
}

async function flush() {
  if (flushing) return; // the running flush loop will pick up whatever we just queued
  flushing = true;
  try {
    while (pending.length) await commitBatch(pending.splice(0, MAX_BATCH));
  } finally {
    flushing = false; // no await between the loop check and here, so no appended item can be missed
  }
}

async function commitBatch(batch: Pending[]) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      if (head === undefined) head = await readHead();
      let prev: AuditEntry | null = head;
      const entries = batch.map((p) => (prev = makeEntry(prev, p.kind, p.stored)));
      const { text, params } = buildBatchInsert(entries);
      await db().query(text, params);
      head = entries[entries.length - 1];
      batch.forEach((p, i) => p.resolve(entries[i]));
      return;
    } catch (err) {
      head = undefined; // unknown after any failure: re-read from the DB
      if (!isUniqueViolation(err)) { batch.forEach((p) => p.reject(err)); return; }
      await new Promise((r) => setTimeout(r, Math.random() * 15 * (attempt + 1))); // jitter against cross-instance pile-ups
    }
  }
  batch.forEach((p) => p.reject(new Error("audit append contention")));
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
