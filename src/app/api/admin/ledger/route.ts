import { z } from "zod";
import { sessionFromRequest } from "@/lib/auth/guard.ts";
import { guard } from "@/lib/ratelimit.ts";
import { ledgerPage, ledgerSummary } from "@/lib/db/store.ts";

const Q = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.coerce.number().int().positive().optional(),
});

/** Captured payments for this tenant (integer minor units), keyset-paginated. The first page also carries totals per currency. */
export async function GET(req: Request) {
  const s = sessionFromRequest(req);
  if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
  const limited = await guard(`dash:${s.keyId}`, { limit: 240, windowSec: 60 });
  if (limited) return limited;

  const q = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) return Response.json({ error: "invalid_query" }, { status: 400 });
  try {
    const rows = await ledgerPage(s.tenantId, q.data);
    return Response.json({
      rows,
      nextBefore: rows.length === q.data.limit ? rows[rows.length - 1].id : null,
      summary: q.data.before === undefined ? await ledgerSummary(s.tenantId) : undefined,
    });
  } catch {
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
