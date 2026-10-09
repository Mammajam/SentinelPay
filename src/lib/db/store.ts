import { db } from "./client.ts";
import { Policy } from "../policy/schema.ts";
import { envMs, TtlCache } from "../cache.ts";

// Advisory-path caches (validate-cart only). The webhook/capture path calls getPolicy()/merchantBelongsToTenant()
// directly via the *Fresh* variants below so money movement never trusts a cached answer.
const policyCache = new TtlCache<PolicyRow>(envMs("POLICY_CACHE_TTL_MS", 5_000));
const merchantCache = new TtlCache<true>(envMs("MERCHANT_CACHE_TTL_MS", 30_000));
export const invalidatePolicy = (id: string) => policyCache.deleteWhere((k) => k.endsWith(`:${id}`));

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

/**
 * Tenant-scoped read for authenticated API callers. A policy owned by another tenant is
 * indistinguishable from a missing one (no existence oracle).
 */
export async function getPolicyForTenant(id: string, tenantId: string, opts: { fresh?: boolean } = {}): Promise<PolicyRow | null> {
  const ck = `${tenantId}:${id}`;
  if (!opts.fresh) { const hit = policyCache.get(ck); if (hit) return hit; }
  const p = await getPolicy(id);
  if (!p || p.ownerId !== tenantId) return null;
  if (p.status === "active") policyCache.set(ck, p); // never cache draft/revoked: activation and revocation must show at once
  return p;
}

/** Activates only if the caller echoes the exact hash they were shown AND owns the policy. */
export async function activatePolicy(id: string, hash: string, by: string, tenantId: string): Promise<boolean> {
  const { rowCount } = await db().query(
    "UPDATE policies SET status='active', confirmed_by=$3, confirmed_at=now() WHERE id=$1 AND status='draft' AND compiled_hash=$2 AND owner_id=$4",
    [id, hash, by, tenantId],
  );
  invalidatePolicy(id);
  return (rowCount ?? 0) === 1;
}

/** Kill-switch: a revoked policy can never validate or authorize a capture again. Draft or active only. */
export async function revokePolicy(id: string, tenantId: string): Promise<boolean> {
  const { rowCount } = await db().query(
    "UPDATE policies SET status='revoked' WHERE id=$1 AND owner_id=$2 AND status IN ('draft','active')",
    [id, tenantId],
  );
  invalidatePolicy(id); // this instance stops serving the cached copy at once; others within the TTL
  return (rowCount ?? 0) === 1;
}

/* ---------------- tenants & merchant binding ---------------- */

export async function createTenant(id: string, name: string) {
  await db().query("INSERT INTO tenants (id, name) VALUES ($1,$2)", [id, name]);
}

/** A merchant can belong to exactly one tenant; re-registering under another tenant fails. */
export async function registerMerchant(tenantId: string, merchantId: string) {
  const { rows } = await db().query(
    "INSERT INTO tenant_merchants (merchant_id, tenant_id) VALUES ($1,$2) ON CONFLICT (merchant_id) DO UPDATE SET tenant_id = tenant_merchants.tenant_id RETURNING tenant_id",
    [merchantId, tenantId],
  );
  if (rows[0].tenant_id !== tenantId) throw new Error(`merchant ${merchantId} already belongs to another tenant`);
}

/** Fail-closed: an unregistered merchant belongs to nobody. */
export async function merchantBelongsToTenant(merchantId: string, tenantId: string, opts: { fresh?: boolean } = {}): Promise<boolean> {
  const ck = `${merchantId}\u0000${tenantId}`;
  if (!opts.fresh && merchantCache.get(ck)) return true; // only positives are cached: a new registration works at once
  const { rows } = await db().query("SELECT 1 FROM tenant_merchants WHERE merchant_id=$1 AND tenant_id=$2", [merchantId, tenantId]);
  if (rows.length === 1) { merchantCache.set(ck, true); return true; }
  return false;
}

export async function tenantName(tenantId: string): Promise<string | null> {
  const { rows } = await db().query("SELECT name FROM tenants WHERE id=$1", [tenantId]);
  return rows[0]?.name ?? null;
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

export async function recentValidations(tenantId: string, limit = 50) {
  const { rows } = await db().query(
    "SELECT v.id, v.policy_id AS \"policyId\", v.cart_id AS \"cartId\", v.decision, v.violations, v.at FROM validations v JOIN policies p ON p.id = v.policy_id WHERE p.owner_id = $1 ORDER BY v.id DESC LIMIT $2",
    [tenantId, limit],
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

/* ---------------- dashboard reads (always tenant-scoped) ---------------- */

/** Keyset pagination (stable under inserts): pass the smallest id from the previous page as `before`. */
export async function validationsPage(tenantId: string, o: { limit: number; before?: number; decision?: string }) {
  const { rows } = await db().query(
    `SELECT v.id::int AS id, v.policy_id AS "policyId", v.cart_id AS "cartId", v.decision, v.violations, v.at
       FROM validations v JOIN policies p ON p.id = v.policy_id
      WHERE p.owner_id = $1 AND ($2::bigint IS NULL OR v.id < $2) AND ($3::text IS NULL OR v.decision = $3)
      ORDER BY v.id DESC LIMIT $4`,
    [tenantId, o.before ?? null, o.decision ?? null, o.limit],
  );
  return rows;
}

export async function listPolicies(tenantId: string, limit = 50) {
  const { rows } = await db().query(
    `SELECT id, status, source_text AS "sourceText", compiled, compiled_hash AS "hash", created_at AS "createdAt", confirmed_at AS "confirmedAt"
       FROM policies WHERE owner_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}

/**
 * Orders whose capture failed and which have NOT since been captured. `attempt` is the highest
 * attempt number used so far (0 = the original automatic attempt).
 */
export async function openCaptureFailures(tenantId: string, limit = 50) {
  const { rows } = await db().query(
    `SELECT DISTINCT ON (a.payload->>'orderId')
            a.payload->>'orderId' AS "orderId", a.payload->>'policyId' AS "policyId", a.payload->>'issue' AS issue,
            (a.payload->>'ambiguous')::boolean AS ambiguous, a.payload->'action'->>'type' AS "actionType", a.at,
            COALESCE((SELECT max((r.payload->>'attempt')::int) FROM audit_log r
                       WHERE r.kind = 'order.capture_retriggered' AND r.payload->>'orderId' = a.payload->>'orderId'), 0) AS attempt
       FROM audit_log a JOIN policies p ON p.id::text = a.payload->>'policyId'
      WHERE a.kind = 'order.capture_failed' AND p.owner_id = $1
        AND NOT EXISTS (SELECT 1 FROM audit_log c WHERE c.kind = 'order.captured' AND c.payload->>'orderId' = a.payload->>'orderId')
      ORDER BY a.payload->>'orderId', a.seq DESC
      LIMIT $2`,
    [tenantId, limit],
  );
  return rows as Array<{ orderId: string; policyId: string; issue: string | null; ambiguous: boolean; actionType: string; at: string; attempt: number }>;
}
