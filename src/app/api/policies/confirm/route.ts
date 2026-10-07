import { z } from "zod";
import { authenticate, denied } from "@/lib/auth/keys.ts";
import { activatePolicy } from "@/lib/db/store.ts";
import { appendAudit } from "@/lib/db/audit.ts";

const Body = z.object({ id: z.uuid(), hash: z.string().regex(/^[0-9a-f]{64}$/) });

/**
 * Human confirmation: activates a draft only if
 *   1. the admin key is valid AND a fresh single-use TOTP code is supplied (`x-sentinel-totp`) —
 *      this is the "a human reviewed it" gate, so a leaked API key alone cannot activate a policy;
 *   2. the policy belongs to the caller's tenant;
 *   3. the echoed hash matches what was read back.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, "admin", { totp: true });
  if (!auth.ok) return denied(auth);
  const { tenantId, keyId } = auth.principal;

  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "invalid_request" }, { status: 400 });

  try {
    const ok = await activatePolicy(body.data.id, body.data.hash, keyId, tenantId);
    // Same answer for "not yours", "not a draft", and "wrong hash": no information leak.
    if (!ok) return Response.json({ error: "hash_mismatch_or_not_draft" }, { status: 409 });
    await appendAudit("policy.activated", { id: body.data.id, tenantId, hash: body.data.hash, keyId });
    return Response.json({ id: body.data.id, status: "active" });
  } catch {
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
