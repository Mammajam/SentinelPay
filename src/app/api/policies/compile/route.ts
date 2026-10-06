import { z } from "zod";
import { authorize, unauthorized } from "@/lib/auth.ts";
import { getCompiler } from "@/lib/agent/geap.ts";
import { policyHash, readback } from "@/lib/policy/readback.ts";
import { insertDraftPolicy } from "@/lib/db/store.ts";
import { appendAudit } from "@/lib/db/audit.ts";


const Body = z.object({
  ownerId: z.string().min(1),
  directive: z.string().min(3).max(1000),
  currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
});

/** Natural language -> DRAFT policy + deterministic readback. Never activates anything. */
export async function POST(req: Request) {
  const auth = authorize(req, "admin");
  if (!auth.ok) return unauthorized();
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "invalid_request" }, { status: 400 });

  try {
    const compiler = getCompiler();
    const compiled = await compiler.compile(body.data.directive, { currency: body.data.currency });
    const hash = policyHash(compiled);
    const id = await insertDraftPolicy({ ownerId: body.data.ownerId, sourceText: body.data.directive, compiled, hash, compiler: compiler.id });
    await appendAudit("policy.drafted", { id, hash, by: auth.principal, compiler: compiler.id });
    return Response.json({ id, status: "draft", hash, readback: readback(compiled), compiled });
  } catch {
    return Response.json({ error: "compile_failed" }, { status: 502 });
  }
}
