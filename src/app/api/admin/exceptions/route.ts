import { sessionFromRequest } from "@/lib/auth/guard.ts";
import { guard } from "@/lib/ratelimit.ts";
import { openCaptureFailures } from "@/lib/db/store.ts";

/** Orders whose capture failed and have not since been captured (the exception queue). Read-only. */
export async function GET(req: Request) {
  const s = sessionFromRequest(req);
  if (!s) return Response.json({ error: "unauthorized" }, { status: 401 });
  const limited = await guard(`dash:${s.keyId}`, { limit: 240, windowSec: 60 });
  if (limited) return limited;
  try {
    return Response.json({ exceptions: await openCaptureFailures(s.tenantId) });
  } catch {
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
