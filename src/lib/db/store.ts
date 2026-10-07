import { db } from "./client.ts";
import { Policy } from "../policy/schema.ts";

export interface PolicyRow {
  id: string;
  ownerId: string;
  status: "draft" | "active" | "revoked";
  compiled: Policy;
  compiledHash: string;
}

export async function insertDraftPolicy(a: { ownerId: string; sourceText: string; compiled: Policy; hash: string; compiler: string }) {
  const { rows } = await db().query(
    "INSERT INTO policies (owner_id, source_text, compiled, compiled_hash, compiler) VALUES ($1,$2,$3,$4,$5) RETURNING id",
    [a.ownerId, a.sourceText, JSON.stringify(a.compiled), a.hash, a.compiler],
  );
  return rows[0].id as string;
}

export async function getPolicy(id: string): Promise<PolicyRow | null> {
  const { rows } = await db().query(
    "SELECT id, owner_id AS \"ownerId\", status, compiled, compiled_hash AS \"compiledHash\" FROM policies WHERE id = $1",
    [id],
  );
  if (!rows[0]) return null;
  // Re-validate on every read: a corrupted row must fail closed, not evaluate.
  const compiled = Policy.parse(rows[0].compiled);
  return { ...rows[0], compiled } as PolicyRow;
}

/** Activates only if the caller echoes the exact hash they were shown. */
export async function activatePolicy(id: string, hash: string, by: string): Promise<boolean> {
  const { rowCount } = await db().query(
    "UPDATE policies SET status='active', confirmed_by=$3, confirmed_at=now() WHERE id=$1 AND status='draft' AND compiled_hash=$2",
    [id, hash, by],
  );
  return (rowCount ?? 0) === 1;
}

/** Settled spend (minor units) within a window, for cumulative_budget. */
export async function spentInWindow(policyId: string, windowDays: number): Promise<number> {
  const { rows } = await db().query(
    "SELECT COALESCE(SUM(amount),0)::bigint AS s FROM spend_ledger WHERE policy_id=$1 AND at > now() - make_interval(days => $2)",
    [policyId, windowDays],
  );
  return Number(rows[0].s);
}

/** True if this event id was new (and is now claimed); false if it is a replay. */
export async function claimWebhookEvent(eventId: string, type: string): Promise<boolean> {
  const { rowCount } = await db().query(
    "INSERT INTO webhook_events (event_id, event_type) VALUES ($1,$2) ON CONFLICT DO NOTHING",
    [eventId, type],
  );
  return (rowCount ?? 0) === 1;
}

export async function recordValidation(policyId: string, cartId: string, decision: string, violations: unknown) {
  await db().query("INSERT INTO validations (policy_id, cart_id, decision, violations) VALUES ($1,$2,$3,$4)", [
    policyId, cartId, decision, JSON.stringify(violations),
  ]);
}

export async function recentValidations(limit = 50) {
  const { rows } = await db().query(
    "SELECT id, policy_id AS \"policyId\", cart_id AS \"cartId\", decision, violations, at FROM validations ORDER BY id DESC LIMIT $1",
    [limit],
  );
  return rows;
}

/** Un-claim an event whose processing failed, so PayPal's retry is processed (all side effects are idempotent). */
export async function releaseWebhookEvent(eventId: string) {
  await db().query("DELETE FROM webhook_events WHERE event_id=$1", [eventId]);
}

/** Record settled spend. Returns false if this capture id was already recorded (replay-safe). */
export async function recordSpend(policyId: string, captureId: string, amount: number, currency: string): Promise<boolean> {
  const { rowCount } = await db().query(
    "INSERT INTO spend_ledger (policy_id, capture_id, amount, currency) VALUES ($1,$2,$3,$4) ON CONFLICT (capture_id) DO NOTHING",
    [policyId, captureId, amount, currency],
  );
  return (rowCount ?? 0) === 1;
}
