import { z } from "zod";
import { authorize, unauthorized } from "@/lib/auth.ts";
import { evaluate } from "@/lib/policy/evaluate.ts";
import { getPolicy, recordValidation, spentInWindow } from "@/lib/db/store.ts";
import { appendAudit } from "@/lib/db/audit.ts";


const Body = z.object({ policyId: z.uuid(), cart: z.unknown() });
// Fail-closed envelope: any internal failure is reported as DENY, never as ALLOW.
const failClosed = (code: string, status = 503) =>
  Response.json({ decision: "DENY", violations: [{ rule: "integrity", code, message: code }] }, { status });

export async function POST(req: Request) {
  const auth = authorize(req, "agent");
  if (!auth.ok) return unauthorized();
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return failClosed("BAD_REQUEST", 400);

  try {
    const policy = await getPolicy(body.data.policyId);
    if (!policy || policy.status !== "active") return failClosed("POLICY_NOT_ACTIVE", 403);

    // Pre-fetch ledger sums for every budget window (evaluator is synchronous & pure).
    const windows = [...new Set(policy.compiled.rules.flatMap((r) => (r.kind === "cumulative_budget" ? [r.windowDays] : [])))];
    const sums = new Map(await Promise.all(windows.map(async (w) => [w, await spentInWindow(policy.id, w)] as const)));

    const result = evaluate(policy.compiled, body.data.cart, {
      now: new Date(),
      spentInWindow: (w) => sums.get(w) ?? NaN,
    });

    const cartId = (body.data.cart as { cartId?: string })?.cartId ?? "unknown";
    await recordValidation(policy.id, cartId, result.decision, result.violations);
    await appendAudit("cart.validated", { policyId: policy.id, cartId, decision: result.decision, violations: result.violations });
    return Response.json(result);
  } catch {
    return failClosed("INTERNAL_ERROR");
  }
}
