import { z } from "zod";
import { authenticate, denied } from "@/lib/auth/keys.ts";
import { revokePolicy } from "@/lib/db/store.ts";
import { appendAudit } from "@/lib/db/audit.ts";
import { log } from "@/lib/log.ts";

const Body = z.object({ id: z.uuid() });

/**
 * Kill-switch. Admin key + single-use TOTP (same bar as activation: a leaked key alone cannot
 * change what is enforced). Immediate effect: a revoked policy fails validate-cart (403) and any
 * order under it is DENIED at the webhook, so no further capture can be authorized.
 * Tenant-scoped; "not yours", "already revoked" and "unknown" all answer 409.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, "admin", { totp: true });
  if (!auth.ok) return denied(auth);
  const { tenantId, keyId } = auth.principal;

  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "invalid_request" }, { status: 400 });

  try {
    if (!(await revokePolicy(body.data.id, tenantId))) return Response.json({ error: "not_revocable" }, { status: 409 });
    await appendAudit("policy.revoked", { id: body.data.id, tenantId, keyId });
    log("WARNING", "policy.revoked", { policyId: body.data.id, tenantId });
    return Response.json({ id: body.data.id, status: "revoked" });
  } catch {
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
