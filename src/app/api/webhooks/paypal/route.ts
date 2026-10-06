import { verifyWebhook } from "@/lib/paypal/webhook.ts";
import { orderToCart } from "@/lib/paypal/orders.ts";
import { evaluate } from "@/lib/policy/evaluate.ts";
import { claimWebhookEvent, getPolicy, spentInWindow } from "@/lib/db/store.ts";
import { appendAudit } from "@/lib/db/audit.ts";


const certCache = new Map<string, string>();
async function fetchCertPem(url: string) {
  const hit = certCache.get(url);
  if (hit) return hit;
  const r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error("cert fetch failed");
  const pem = await r.text();
  certCache.set(url, pem);
  return pem;
}

export async function POST(req: Request) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return Response.json({ error: "not_configured" }, { status: 503 });

  // Raw bytes: the CRC32 in the signed string is over the exact body received.
  const raw = Buffer.from(await req.arrayBuffer());
  const h = req.headers;
  const v = await verifyWebhook(
    raw,
    {
      authAlgo: h.get("paypal-auth-algo") ?? "",
      certUrl: h.get("paypal-cert-url") ?? "",
      transmissionId: h.get("paypal-transmission-id") ?? "",
      transmissionSig: h.get("paypal-transmission-sig") ?? "",
      transmissionTime: h.get("paypal-transmission-time") ?? "",
    },
    { webhookId, fetchCertPem },
  );
  if (!v.ok) {
    await appendAudit("webhook.rejected", { reason: v.reason }).catch(() => {});
    return Response.json({ error: "invalid_signature" }, { status: 400 });
  }

  try {
    const evt = JSON.parse(raw.toString("utf8")) as { id: string; event_type: string; resource: Parameters<typeof orderToCart>[0] };
    if (!(await claimWebhookEvent(evt.id, evt.event_type))) return Response.json({ ok: true, replay: true });

    if (evt.event_type === "CHECKOUT.ORDER.APPROVED") {
      // Final inspection BEFORE capture. Any failure => no capture is authorized.
      let decision = "DENY";
      let detail: unknown = "inspection_error";
      try {
        const { policyId, cart } = orderToCart(evt.resource);
        const policy = await getPolicy(policyId);
        if (policy?.status === "active") {
          const windows = [...new Set(policy.compiled.rules.flatMap((r) => (r.kind === "cumulative_budget" ? [r.windowDays] : [])))];
          const sums = new Map(await Promise.all(windows.map(async (w) => [w, await spentInWindow(policy.id, w)] as const)));
          const r = evaluate(policy.compiled, cart, { now: new Date(), spentInWindow: (w) => sums.get(w) ?? NaN });
          decision = r.decision;
          detail = r.violations;
        }
      } catch { /* stays DENY */ }
      await appendAudit("order.inspected", { eventId: evt.id, orderId: evt.resource?.id, decision, detail });
      // TODO(Phase 2): on ALLOW, call POST /v2/checkout/orders/{id}/capture with
      // PayPal-Request-Id = requestId({...}) from lib/paypal/idempotency.ts.
    } else {
      await appendAudit("webhook.received", { eventId: evt.id, type: evt.event_type });
      // TODO(Phase 2): PAYMENT.CAPTURE.COMPLETED -> INSERT spend_ledger; VAULT.PAYMENT-TOKEN.CREATED -> bind token.
    }
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
