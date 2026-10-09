import { z } from "zod";
import { authenticate, denied } from "@/lib/auth/keys.ts";
import { guard, LIMITS } from "@/lib/ratelimit.ts";
import { getCompiler } from "@/lib/agent/geap.ts";
import { policyHash, readback } from "@/lib/policy/readback.ts";
import { insertDraftPolicy } from "@/lib/db/store.ts";
import { appendAudit } from "@/lib/db/audit.ts";
import { log } from "@/lib/log.ts";

// NOTE: no `ownerId` in the body. The tenant comes from the authenticated key, so an admin can
// only ever create policies for their own tenant.
const Body = z.object({
  directive: z.string().min(3).max(1000),
  currency: z.string().regex(/^[A-Z]{3}$/).default("USD"),
});

/** Natural language -> DRAFT policy + deterministic readback. Never activates anything. */
export async function POST(req: Request) {
  const auth = await authenticate(req, "admin");
  if (!auth.ok) return denied(auth);
  const { tenantId, keyId } = auth.principal;

  // LLM cost control: hourly burst limit and a daily quota, both per tenant.
  const limited =
    (await guard(`compile:h:${tenantId}`, LIMITS.compile())) ?? (await guard(`compile:d:${tenantId}`, LIMITS.compileDaily()));
  if (limited) return limited;

  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "invalid_request" }, { status: 400 });

  try {
    const compiler = getCompiler();
    const compiled = await compiler.compile(body.data.directive, { currency: body.data.currency });
    const hash = policyHash(compiled);
    const id = await insertDraftPolicy({ ownerId: tenantId, sourceText: body.data.directive, compiled, hash, compiler: compiler.id });
    await appendAudit("policy.drafted", { id, tenantId, hash, keyId, compiler: compiler.id });
    return Response.json({ id, status: "draft", hash, readback: readback(compiled), compiled });
  } catch (e) {
    // Log WHY (never the directive text, which may hold personal data) so failures are diagnosable.
    log("ERROR", "policy.compile_failed", { tenantId, reason: e instanceof Error ? e.message.slice(0, 300) : "unknown" });
    return Response.json({ error: "compile_failed" }, { status: 502 });
  }
}
