import { z } from "zod";
import { authenticate, denied } from "@/lib/auth/keys.ts";
import { guard, LIMITS } from "@/lib/ratelimit.ts";
import { getPolicyForTenant } from "@/lib/db/store.ts";
import { readback } from "@/lib/policy/readback.ts";

/** Read-only: an agent may learn its OWN tenant's limits in plain language. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req, "agent");
  if (!auth.ok) return denied(auth);
  const limited = await guard(`validate:${auth.principal.keyId}`, LIMITS.validate());
  if (limited) return limited;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) return Response.json({ error: "not_found" }, { status: 404 });
  try {
    const p = await getPolicyForTenant(id, auth.principal.tenantId);
    if (!p) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json({ id: p.id, status: p.status, rules: readback(p.compiled) });
  } catch {
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
