import { z } from "zod";
import { verifyWebhook, devCertOrigin } from "@/lib/paypal/webhook.ts";
import { orderToCart, toMinor } from "@/lib/paypal/orders.ts";
import { captureOrder } from "@/lib/paypal/capture.ts";
import { evaluate } from "@/lib/policy/evaluate.ts";
import { claimWebhookEvent, getPolicy, merchantBelongsToTenant, recordSpend, releaseWebhookEvent, spentInWindow } from "@/lib/db/store.ts";
import { appendAudit } from "@/lib/db/audit.ts";
import { log } from "@/lib/log.ts";

const CERT_TTL_MS = 60 * 60 * 1000;
const CERT_MAX = 20;
const certCache = new Map<string, { pem: string; at: number }>();
async function fetchCertPem(url: string) {
  const hit = certCache.get(url);
  if (hit && Date.now() - hit.at < CERT_TTL_MS) return hit.pem;
  const r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error("cert fetch failed");
  const pem = await r.text();
  if (certCache.size >= CERT_MAX) certCache.delete(certCache.keys().next().value as string); // bounded
  certCache.set(url, { pem, at: Date.now() });
  return pem;
}

const Event = z.object({ id: z.string().min(1), event_type: z.string().min(1), resource: z.unknown() });
const CaptureResource = z.object({
  id: z.string().min(1),
  custom_id: z.uuid().optional(),
  amount: z.object({ currency_code: z.string(), value: z.string() }),
});

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
    { webhookId, fetchCertPem, devCertOrigin: devCertOrigin(process.env) },
  );
  if (!v.ok) {
    await appendAudit("webhook.rejected", { reason: v.reason }).catch(() => {});
    log("WARNING", "webhook.rejected", { reason: v.reason });
    return Response.json({ error: "invalid_signature" }, { status: 400 });
  }

  let json: unknown;
  try { json = JSON.parse(raw.toString("utf8")); } catch { return Response.json({ error: "bad_event" }, { status: 400 }); }
  const parsed = Event.safeParse(json);
  if (!parsed.success) return Response.json({ error: "bad_event" }, { status: 400 });
  const evt = parsed.data;

  if (!(await claimWebhookEvent(evt.id, evt.event_type))) return Response.json({ ok: true, replay: true });

  try {
    if (evt.event_type === "CHECKOUT.ORDER.APPROVED") {
      // Final inspection BEFORE capture. Any failure => no capture is authorized.
      let decision = "DENY";
      let detail: unknown = "inspection_error";
      let policyId: string | undefined;
      let orderId: string | undefined;
      try {
        const order = evt.resource as Parameters<typeof orderToCart>[0];
        orderId = order.id;
        const conv = orderToCart(order);
        policyId = conv.policyId;
        const policy = await getPolicy(conv.policyId);
        if (policy?.status === "active" && !(await merchantBelongsToTenant(conv.cart.merchantId, policy.ownerId))) {
          // Cross-tenant guard: the order's merchant must belong to the policy's tenant, otherwise
          // one tenant could apply (or burn the cumulative budget of) another tenant's policy.
          detail = "merchant_not_registered_for_policy_tenant";
        } else if (policy?.status === "active") {
          const windows = [...new Set(policy.compiled.rules.flatMap((r) => (r.kind === "cumulative_budget" ? [r.windowDays] : [])))];
          const sums = new Map(await Promise.all(windows.map(async (w) => [w, await spentInWindow(policy.id, w)] as const)));
          const r = evaluate(policy.compiled, conv.cart, { now: new Date(), spentInWindow: (w) => sums.get(w) ?? NaN });
          decision = r.decision;
          detail = r.violations;
        } else {
          detail = "policy_not_active";
        }
      } catch { /* stays DENY */ }
      await appendAudit("order.inspected", { eventId: evt.id, orderId, policyId, decision, detail });
      log("INFO", "order.inspected", { decision });

      // Capture is initiated ONLY by SentinelPay and ONLY on ALLOW.
      if (decision === "ALLOW" && policyId && orderId) {
        const out = await captureOrder({ orderId, policyId });
        if (out.status === "CAPTURED") {
          await appendAudit("order.captured", { orderId, policyId, captureId: out.captureId, requestId: out.requestId });
        } else {
          await appendAudit("order.capture_failed", { orderId, policyId, http: out.http, issue: out.issue, action: out.action, ambiguous: out.ambiguous, requestId: out.requestId });
          log("ERROR", "order.capture_failed", { issue: out.issue, http: out.http, ambiguous: out.ambiguous });
        }
      }
    } else if (evt.event_type === "PAYMENT.CAPTURE.COMPLETED") {
      const cap = CaptureResource.safeParse(evt.resource);
      if (!cap.success || !cap.data.custom_id) {
        await appendAudit("capture.unattributed", { eventId: evt.id });
      } else {
        const minor = toMinor(cap.data.amount.value, cap.data.amount.currency_code);
        const fresh = await recordSpend(cap.data.custom_id, cap.data.id, minor, cap.data.amount.currency_code);
        await appendAudit("capture.recorded", { eventId: evt.id, captureId: cap.data.id, policyId: cap.data.custom_id, amount: minor, newlyRecorded: fresh });
      }
    } else {
      await appendAudit("webhook.received", { eventId: evt.id, type: evt.event_type });
      // TODO: VAULT.PAYMENT-TOKEN.CREATED -> bind token reference (id only, never the raw token).
    }
    return Response.json({ ok: true });
  } catch {
    // Un-claim so PayPal's retry is processed. Safe: capture uses a deterministic
    // PayPal-Request-Id and the ledger insert is idempotent on capture_id.
    await releaseWebhookEvent(evt.id).catch(() => {});
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
