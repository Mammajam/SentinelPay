import { z } from "zod";
import { authenticate, denied } from "@/lib/auth/keys.ts";
import { guard, LIMITS } from "@/lib/ratelimit.ts";
import { evaluate } from "@/lib/policy/evaluate.ts";
import { getPolicyForTenant, merchantBelongsToTenant, recordValidation, spentInWindow } from "@/lib/db/store.ts";
import { appendAudit } from "@/lib/db/audit.ts";
import { log } from "@/lib/log.ts";

const Body = z.object({ policyId: z.uuid(), cart: z.unknown() });
// Fail-closed envelope: any internal failure is reported as DENY, never as ALLOW.
const failClosed = (code: string, status = 503) =>
  Response.json({ decision: "DENY", violations: [{ rule: "integrity", code, message: code }] }, { status });

export async function POST(req: Request) {
  const t0 = Date.now();
  const auth = await authenticate(req, "agent");
  if (!auth.ok) return denied(auth);
  const { tenantId, keyId } = auth.principal;

  const limited = await guard(`validate:${keyId}`, LIMITS.validate());
  if (limited) return limited;

  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return failClosed("BAD_REQUEST", 400);

  try {
    // Another tenant's policy looks exactly like a missing one.
    const policy = await getPolicyForTenant(body.data.policyId, tenantId);
    if (!policy || policy.status !== "active") return failClosed("POLICY_NOT_ACTIVE", 403);

    // Pre-fetch ledger sums for every budget window (evaluator is synchronous & pure).
    const windows = [...new Set(policy.compiled.rules.flatMap((r) => (r.kind === "cumulative_budget" ? [r.windowDays] : [])))];
    const sums = new Map(await Promise.all(windows.map(async (w) => [w, await spentInWindow(policy.id, w)] as const)));

    const result = evaluate(policy.compiled, body.data.cart, {
      now: new Date(),
      spentInWindow: (w) => sums.get(w) ?? NaN,
    });

    // The merchant must be registered to THIS tenant, whatever the policy says (fail-closed).
    const merchantId = (body.data.cart as { merchantId?: unknown } | null)?.merchantId;
    if (typeof merchantId !== "string" || !(await merchantBelongsToTenant(merchantId, tenantId))) {
      result.decision = "DENY";
      result.violations.unshift({ rule: "integrity", code: "MERCHANT_NOT_REGISTERED", message: "Merchant is not registered to this tenant" });
    }

    const cartId = (body.data.cart as { cartId?: string })?.cartId ?? "unknown";
    await recordValidation(policy.id, cartId, result.decision, result.violations);
    await appendAudit("cart.validated", { policyId: policy.id, tenantId, cartId, decision: result.decision, violations: result.violations });
    log("INFO", "cart.validated", { tenantId, decision: result.decision, codes: result.violations.map((v) => v.code), latencyMs: Date.now() - t0 });
    return Response.json(result);
  } catch {
    log("ERROR", "cart.validate_failed", { tenantId, latencyMs: Date.now() - t0 });
    return failClosed("INTERNAL_ERROR");
  }
}
