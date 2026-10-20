import { open, seal } from "../crypto/secretbox.ts";

/**
 * Opaque, tenant-bound pagination cursor for the audit explorer.
 * The audit chain is GLOBAL, so its `seq` would reveal how much OTHER tenants are doing. We therefore never
 * return `seq`; the cursor is the seq sealed (AES-256-GCM) with the tenant as associated data, so it is
 * meaningless to the client and cannot be replayed under another tenant.
 */
export const sealCursor = (seq: number, tenantId: string, env?: Record<string, string | undefined>): string =>
  seal(String(seq), `audit-cursor:${tenantId}`, env);

/** Returns the seq, or null for any malformed / tampered / foreign-tenant cursor (fail closed). */
export function openCursor(token: string, tenantId: string, env?: Record<string, string | undefined>): number | null {
  try {
    const n = Number(open(token, `audit-cursor:${tenantId}`, env));
    return Number.isSafeInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
