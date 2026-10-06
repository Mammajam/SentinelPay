import { z } from "zod";
import { authorize, unauthorized } from "@/lib/auth.ts";
import { activatePolicy } from "@/lib/db/store.ts";
import { appendAudit } from "@/lib/db/audit.ts";


const Body = z.object({ id: z.uuid(), hash: z.string().regex(/^[0-9a-f]{64}$/) });

/** Human confirmation: activates a draft only if the echoed hash matches what was read back. */
export async function POST(req: Request) {
  const auth = authorize(req, "admin");
  if (!auth.ok) return unauthorized();
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "invalid_request" }, { status: 400 });

  try {
    const ok = await activatePolicy(body.data.id, body.data.hash, auth.principal);
    if (!ok) return Response.json({ error: "hash_mismatch_or_not_draft" }, { status: 409 });
    await appendAudit("policy.activated", { id: body.data.id, hash: body.data.hash, by: auth.principal });
    return Response.json({ id: body.data.id, status: "active" });
  } catch {
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
