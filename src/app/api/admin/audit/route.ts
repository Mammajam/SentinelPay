import { z } from "zod";
import { sessionFromRequest } from "@/lib/auth/guard.ts";
import { guard } from "@/lib/ratelimit.ts";
import { auditPage } from "@/lib/db/store.ts";
import { boundedPayload, describeAuditEntry, TENANT_KINDS } from "@/lib/audit/view.ts";
import { openCursor, sealCursor } from "@/lib/audit/cursor.ts";
import { entryHash } from "@/lib/audit/chain.ts";

const Q = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(400).optional(),
  kind: z.enum(TENANT_KINDS).optional(),
});

/**
 * Tenant-scoped audit explorer. Read-only, session cookie only.
 * The chain is GLOBAL, so the client never receives `seq` (it would leak other tenants' activity volume):
 * rows are identified by their hash, and pagination uses a sealed, tenant-bound cursor.
 * `selfHashOk` proves each entry still hashes to its stored hash (tamper evidence per row); the full chain and
 * anchors are verified separately in the dashboard header.
 */
export async function GET(req: Request) {
  const s = sessionFromRequest(req);
  if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
  const limited = await guard(`dash:${s.keyId}`, { limit: 240, windowSec: 60 });
  if (limited) return limited;

  const q = Q.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!q.success) return Response.json({ error: "invalid_query" }, { status: 400 });

  let beforeSeq: number | undefined;
  if (q.data.cursor) {
    const n = openCursor(q.data.cursor, s.tenantId);
    if (n === null) return Response.json({ error: "invalid_cursor" }, { status: 400 });
    beforeSeq = n;
  }

  try {
    const rows = await auditPage(s.tenantId, { limit: q.data.limit, beforeSeq, kind: q.data.kind });
    return Response.json({
      rows: rows.map((r) => ({
        id: r.hash,
        kind: r.kind,
        at: r.at,
        hash12: r.hash.slice(0, 12),
        ...describeAuditEntry(r.kind, r.payload),
        payload: boundedPayload(r.payload),
        selfHashOk: entryHash(r.prevHash, r.kind, r.payload, r.at) === r.hash,
      })),
      nextCursor: rows.length === q.data.limit ? sealCursor(rows[rows.length - 1].seq, s.tenantId) : null,
    });
  } catch {
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
