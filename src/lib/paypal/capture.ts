import { paypalFetch, type PayPalCall } from "./client.ts";
import { requestId } from "./idempotency.ts";
import { mitigationFor, type Action } from "./errors.ts";

export type CaptureOutcome =
  | { status: "CAPTURED"; captureId: string; requestId: string }
  | {
      status: "FAILED";
      http: number;
      issue?: string;
      action: Action;
      requestId: string;
      /**
       * true when we cannot know whether PayPal captured (5xx / transport error).
       * Never re-trigger blindly: reconcile via GET order or the
       * PAYMENT.CAPTURE.COMPLETED webhook first. Re-using the SAME request id is safe.
       */
      ambiguous: boolean;
    };

/**
 * Capture an approved order. Called ONLY after the evaluator returned ALLOW.
 * The PayPal-Request-Id is deterministic, so a retry of the same logical capture
 * cannot double-charge. `attempt` is bumped only by a human, after confirming the
 * previous attempt did not settle.
 */
export async function captureOrder(
  a: { orderId: string; policyId: string; attempt?: number },
  call: PayPalCall = paypalFetch,
): Promise<CaptureOutcome> {
  const rid = requestId({ policyId: a.policyId, cartId: a.orderId, operation: "capture", attempt: a.attempt });

  let res: Response;
  try {
    res = await call(`/v2/checkout/orders/${encodeURIComponent(a.orderId)}/capture`, {
      method: "POST",
      body: "{}",
      requestId: rid,
    });
  } catch {
    return { status: "FAILED", http: 0, requestId: rid, ambiguous: true, action: { type: "HALT", reason: "Transport error; outcome unknown. Reconcile before re-triggering" } };
  }

  if (res.status >= 500) {
    return { status: "FAILED", http: res.status, requestId: rid, ambiguous: true, action: { type: "HALT", reason: "PayPal server error; outcome unknown. Reconcile before re-triggering" } };
  }

  const body = (await res.json().catch(() => null)) as {
    details?: Array<{ issue?: string }>;
    purchase_units?: Array<{ payments?: { captures?: Array<{ id: string; status: string }> } }>;
  } | null;

  if (res.ok) {
    const cap = body?.purchase_units?.[0]?.payments?.captures?.[0];
    if (cap?.id && cap.status === "COMPLETED") return { status: "CAPTURED", captureId: cap.id, requestId: rid };
    // 2xx without a completed capture is NOT success.
    return { status: "FAILED", http: res.status, requestId: rid, ambiguous: true, action: { type: "HALT", reason: "Capture response not COMPLETED" } };
  }

  const issue = body?.details?.[0]?.issue;
  return { status: "FAILED", http: res.status, issue, requestId: rid, ambiguous: false, action: mitigationFor("ORDERS_V2", issue ?? "UNKNOWN") };
}
