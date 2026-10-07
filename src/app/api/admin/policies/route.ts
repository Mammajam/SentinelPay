import { sessionFromRequest } from "@/lib/auth/guard.ts";
import { guard } from "@/lib/ratelimit.ts";
import { listPolicies } from "@/lib/db/store.ts";
import { Policy } from "@/lib/policy/schema.ts";
import { readback } from "@/lib/policy/readback.ts";

/** Read-only list of this tenant's policies with the deterministic readback + hash a human confirms. */
export async function GET(req: Request) {
  const s = sessionFromRequest(req);
  if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
  const limited = await guard(`dash:${s.keyId}`, { limit: 240, windowSec: 60 });
  if (limited) return limited;
  try {
    const rows = await listPolicies(s.tenantId);
    return Response.json({
      policies: rows.map((r) => ({
        id: r.id, status: r.status, hash: r.hash, createdAt: r.createdAt, confirmedAt: r.confirmedAt,
        directive: String(r.sourceText).slice(0, 300),
        rules: readback(Policy.parse(r.compiled)), // re-validated: a corrupt row fails the request, not the readback
      })),
    });
  } catch {
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
