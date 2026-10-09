import { z } from "zod";
import { authenticate, denied } from "@/lib/auth/keys.ts";
import { guard } from "@/lib/ratelimit.ts";
import { paypalFetch } from "@/lib/paypal/client.ts";
import { captureOrder } from "@/lib/paypal/capture.ts";
import { orderToCart } from "@/lib/paypal/orders.ts";
import { evaluate } from "@/lib/policy/evaluate.ts";
import { getPolicyForTenant, merchantBelongsToTenant, openCaptureFailures, spentInWindow } from "@/lib/db/store.ts";
import { appendAudit } from "@/lib/db/audit.ts";

const Body = z.object({ orderId: z.string().min(1).max(64), policyId: z.uuid() });

/**
 * Human-triggered retry of a FAILED capture (the "exception panel" action).
 * Money-moving, so it is the strictest endpoint:
 *   1. admin Bearer key + fresh single-use TOTP (a dashboard cookie is NOT accepted);
 *   2. the order must be in THIS tenant's open-failure queue (so it cannot capture arbitrary orders);
 *   3. PayPal is asked for the order's CURRENT state — only APPROVED may proceed (COMPLETED => already
 *      captured, nothing to do), which is the reconciliation step for ambiguous failures;
 *   4. the order is re-evaluated against the policy NOW (limits, merchant binding, budget); only ALLOW proceeds;
 *   5. idempotency: after an AMBIGUOUS failure the SAME PayPal-Request-Id is reused (safe, cannot double-charge);
 *      after a definite failure the attempt number is bumped.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, "admin", { totp: true });
  if (!auth.ok) return denied(auth);
  const { tenantId, keyId } = auth.principal;
  const limited = await guard(`retrigger:${tenantId}`, { limit: 30, windowSec: 3600 });
  if (limited) return limited;

  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "invalid_request" }, { status: 400 });
  const { orderId, policyId } = body.data;

  try {
    const policy = await getPolicyForTenant(policyId, tenantId, { fresh: true });
    if (!policy || policy.status !== "active") return Response.json({ error: "not_found" }, { status: 404 });

    const failure = (await openCaptureFailures(tenantId, 200)).find((f) => f.orderId === orderId && f.policyId === policyId);
    if (!failure) return Response.json({ error: "not_in_exception_queue" }, { status: 409 });

    // Reconcile with PayPal's truth before doing anything.
    const res = await paypalFetch(`/v2/checkout/orders/${encodeURIComponent(orderId)}`);
    if (!res.ok) return Response.json({ error: "order_lookup_failed", http: res.status }, { status: 502 });
    const order = (await res.json()) as Parameters<typeof orderToCart>[0] & { status?: string };
    if (order.status !== "APPROVED") {
      await appendAudit("order.retrigger_refused", { orderId, policyId, tenantId, keyId, reason: `paypal_status_${order.status}` });
      return Response.json({ error: "order_not_capturable", paypalStatus: order.status }, { status: 409 });
    }

    // Re-evaluate against the policy as it is now.
    const conv = orderToCart(order);
    if (conv.policyId !== policyId) return Response.json({ error: "order_policy_mismatch" }, { status: 409 });
    if (!(await merchantBelongsToTenant(conv.cart.merchantId, tenantId, { fresh: true }))) {
      await appendAudit("order.retrigger_refused", { orderId, policyId, tenantId, keyId, reason: "merchant_not_registered" });
      return Response.json({ error: "merchant_not_registered" }, { status: 409 });
    }
    const windows = [...new Set(policy.compiled.rules.flatMap((r) => (r.kind === "cumulative_budget" ? [r.windowDays] : [])))];
    const sums = new Map(await Promise.all(windows.map(async (w) => [w, await spentInWindow(policy.id, w)] as const)));
    const verdict = evaluate(policy.compiled, conv.cart, { now: new Date(), spentInWindow: (w) => sums.get(w) ?? NaN });
    if (verdict.decision !== "ALLOW") {
      await appendAudit("order.retrigger_refused", { orderId, policyId, tenantId, keyId, reason: "policy", decision: verdict.decision, violations: verdict.violations });
      return Response.json({ error: "policy_does_not_allow", decision: verdict.decision, violations: verdict.violations }, { status: 409 });
    }

    const attempt = failure.ambiguous ? failure.attempt : failure.attempt + 1;
    await appendAudit("order.capture_retriggered", { orderId, policyId, tenantId, keyId, attempt, reusedRequestId: failure.ambiguous });

    const out = await captureOrder({ orderId, policyId, attempt });
    if (out.status === "CAPTURED") {
      await appendAudit("order.captured", { orderId, policyId, tenantId, captureId: out.captureId, requestId: out.requestId, retrigger: true });
      return Response.json({ status: "CAPTURED", captureId: out.captureId, attempt });
    }
    await appendAudit("order.capture_failed", { orderId, policyId, tenantId, http: out.http, issue: out.issue, action: out.action, ambiguous: out.ambiguous, requestId: out.requestId, retrigger: true });
    return Response.json({ status: "FAILED", issue: out.issue ?? null, ambiguous: out.ambiguous, action: out.action, attempt }, { status: 409 });
  } catch {
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
