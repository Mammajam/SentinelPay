import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "../db/client.ts";
import { open, seal } from "../crypto/secretbox.ts";
import { newTotpSecret, verifyTotp } from "./totp.ts";

/**
 * Tenant-scoped, hashed, revocable, expiring API keys.
 *  - `agent`: machine key, can only validate carts / read policy readbacks for ITS tenant.
 *  - `admin`: human operator key; sensitive actions additionally require a one-time TOTP code
 *    (header `x-sentinel-totp`). The tenant ALWAYS comes from the key, never from request input.
 * The raw key is shown once at creation; only its SHA-256 is stored. Every failure path
 * (unknown/expired/revoked key, bad MFA, DB or config error) denies — nothing fails open.
 */
export type Role = "agent" | "admin";
export interface Principal { tenantId: string; keyId: string; role: Role }

export type AuthResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403 | 503; code: string };

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
export const generateKey = (role: Role) => `sp_${role === "admin" ? "adm" : "agt"}_${randomBytes(32).toString("base64url")}`;

export async function createApiKey(a: { tenantId: string; role: Role; label?: string; expiresAt?: Date }) {
  const id = randomUUID();
  const key = generateKey(a.role);
  const totpSecret = a.role === "admin" ? newTotpSecret() : undefined;
  await db().query(
    "INSERT INTO api_keys (id, tenant_id, role, key_hash, prefix, label, totp_secret_enc, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
    [id, a.tenantId, a.role, hashKey(key), key.slice(0, 12), a.label ?? "", totpSecret ? seal(totpSecret, id) : null, a.expiresAt ?? null],
  );
  return { id, key, totpSecret };
}

export async function revokeApiKey(id: string, tenantId: string): Promise<boolean> {
  const r = await db().query("UPDATE api_keys SET revoked_at = now() WHERE id=$1 AND tenant_id=$2 AND revoked_at IS NULL", [id, tenantId]);
  return (r.rowCount ?? 0) === 1;
}

/** Operator view of a tenant's keys. Never returns hashes or secrets. */
export async function listApiKeys(tenantId: string) {
  const { rows } = await db().query(
    `SELECT id, role, label, prefix, created_at AS "createdAt", expires_at AS "expiresAt", revoked_at AS "revokedAt", last_used_at AS "lastUsedAt"
       FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );
  return rows as Array<{ id: string; role: Role; label: string; prefix: string; createdAt: string; expiresAt: string | null; revokedAt: string | null; lastUsedAt: string | null }>;
}

/** Issue a replacement (same role/label) THEN revoke the old key, so there is never a window with no valid key. */
export async function rotateApiKey(id: string, tenantId: string) {
  const old = (await listApiKeys(tenantId)).find((k) => k.id === id && !k.revokedAt);
  if (!old) throw new Error("no active key with that id in that tenant");
  const fresh = await createApiKey({ tenantId, role: old.role, label: old.label, expiresAt: old.expiresAt ? new Date(old.expiresAt) : undefined });
  await revokeApiKey(id, tenantId);
  return fresh;
}

const bearer = (req: Request) => /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];

export async function authenticate(req: Request, role: Role, opts: { totp?: boolean } = {}): Promise<AuthResult> {
  return authenticateToken(bearer(req), role, opts.totp ? (req.headers.get("x-sentinel-totp") ?? "") : undefined);
}

/** `totpCode` undefined => MFA not required for this call. */
export async function authenticateToken(token: string | undefined, role: Role, totpCode?: string): Promise<AuthResult> {
  if (!token || !token.startsWith("sp_")) return { ok: false, status: 401, code: "invalid_key" };
  try {
    const { rows } = await db().query(
      `SELECT id, tenant_id AS "tenantId", role, totp_secret_enc AS "totpEnc", totp_last_step::text AS "lastStep"
         FROM api_keys
        WHERE key_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
      [hashKey(token)],
    );
    const k = rows[0] as { id: string; tenantId: string; role: Role; totpEnc: string | null; lastStep: string } | undefined;
    if (!k) return { ok: false, status: 401, code: "invalid_key" };
    if (k.role !== role) return { ok: false, status: 403, code: "wrong_role" };

    if (totpCode !== undefined) {
      if (!k.totpEnc) return { ok: false, status: 401, code: "mfa_not_enrolled" };
      const v = verifyTotp(open(k.totpEnc, k.id), totpCode, new Date(), Number(k.lastStep));
      if (!v.ok) return { ok: false, status: 401, code: "mfa_required_or_invalid" };
      // Atomically consume the step: two concurrent requests with the same code => only one wins.
      const used = await db().query("UPDATE api_keys SET totp_last_step=$2 WHERE id=$1 AND totp_last_step < $2", [k.id, v.step]);
      if ((used.rowCount ?? 0) !== 1) return { ok: false, status: 401, code: "mfa_replayed" };
    }

    db().query("UPDATE api_keys SET last_used_at = now() WHERE id=$1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [k.id]).catch(() => {});
    return { ok: true, principal: { tenantId: k.tenantId, keyId: k.id, role: k.role } };
  } catch {
    return { ok: false, status: 503, code: "auth_unavailable" };
  }
}

export const denied = (r: Extract<AuthResult, { ok: false }>) =>
  Response.json({ error: r.code }, { status: r.status });
