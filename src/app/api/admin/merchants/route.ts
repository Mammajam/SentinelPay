import { sessionFromRequest } from "@/lib/auth/guard.ts";
import { guard } from "@/lib/ratelimit.ts";
import { listMerchants } from "@/lib/db/store.ts";

/** Merchants registered to THIS tenant (the binding that keeps another tenant from using or draining your policies). */
export async function GET(req: Request) {
  const s = sessionFromRequest(req);
  if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
  const limited = await guard(`dash:${s.keyId}`, { limit: 240, windowSec: 60 });
  if (limited) return limited;
  try {
    return Response.json({ merchants: await listMerchants(s.tenantId) });
  } catch {
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
