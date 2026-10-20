import { sessionFromRequest } from "@/lib/auth/guard.ts";
import { guard } from "@/lib/ratelimit.ts";
import { listApiKeys } from "@/lib/auth/keys.ts";

/**
 * READ-ONLY view of this tenant's API keys for the "Access" tab. Returns identifying metadata only:
 * never the key, its hash, or any MFA data. Revoking/rotating stays in the operator CLI on purpose.
 */
export async function GET(req: Request) {
  const s = sessionFromRequest(req);
  if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
  const limited = await guard(`dash:${s.keyId}`, { limit: 240, windowSec: 60 });
  if (limited) return limited;
  try {
    const now = Date.now();
    const keys = (await listApiKeys(s.tenantId)).map((k) => ({
      id: k.id,
      role: k.role,
      label: k.label,
      prefix: k.prefix,
      createdAt: k.createdAt,
      expiresAt: k.expiresAt,
      lastUsedAt: k.lastUsedAt,
      revokedAt: k.revokedAt,
      status: k.revokedAt ? "revoked" : k.expiresAt && Date.parse(k.expiresAt) <= now ? "expired" : "active",
    }));
    return Response.json({ keys });
  } catch {
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
