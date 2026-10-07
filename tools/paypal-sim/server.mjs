// SentinelPay local PayPal SIMULATOR — development/test only. NOT PayPal.
//
// Models, from PayPal's PUBLISHED docs (my reading, not PayPal's behaviour):
//   OAuth token, Orders v2 create/get/capture, PayPal-Request-Id idempotency,
//   DUPLICATE_INVOICE_ID, signed webhooks (id|time|webhookId|crc32(body), RSA-SHA256).
// It cannot prove PayPal's real contract; see docs/PAYPAL_SIMULATOR.md.
//
// Run:  SIM_WEBHOOK_URL=http://localhost:3000/api/webhooks/paypal node tools/paypal-sim/server.mjs
import http from "node:http";
import { generateKeyPairSync, createSign, randomUUID } from "node:crypto";
import { crc32 } from "node:zlib"; // independent CRC32 implementation (not ours)

const PORT = Number(process.env.SIM_PORT ?? 4010);
const ORIGIN = `http://localhost:${PORT}`;
const WEBHOOK_URL = process.env.SIM_WEBHOOK_URL ?? "http://localhost:3000/api/webhooks/paypal";
const WEBHOOK_ID = process.env.SIM_WEBHOOK_ID ?? "SIM-WEBHOOK-ID";

const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const CERT_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();

/** @type {Map<string, any>} */ const orders = new Map();
/** @type {Map<string, string>} invoice_id -> order id */ const invoices = new Map();
/** @type {Map<string, {status:number, body:any}>} idempotency replay store */ const idem = new Map();
/** @type {any[]} */ const deliveries = [];

const cents = (v) => {
  const m = /^(\d+)\.(\d{2})$/.exec(String(v));
  if (!m) throw new Error(`bad money ${v}`);
  return Number(m[1]) * 100 + Number(m[2]);
};
const money = (c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
const readJson = (req) =>
  new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve(null); } });
  });
const unprocessable = (issue, description) => ({ name: "UNPROCESSABLE_ENTITY", details: [{ issue, description }], message: "The requested action could not be performed" });

/* ---------------- webhook delivery ---------------- */
// fault: none | tamper | stale | badcert | replay
async function deliver(eventType, resource, fault = "none") {
  const event = { id: `WH-${randomUUID()}`, event_type: eventType, resource_type: "sim", create_time: new Date().toISOString(), resource };
  let body = JSON.stringify(event);
  const transmissionId = randomUUID();
  const time = new Date(Date.now() - (fault === "stale" ? 3_600_000 : 0)).toISOString();
  const signed = `${transmissionId}|${time}|${WEBHOOK_ID}|${crc32(Buffer.from(body))}`;
  const sig = createSign("RSA-SHA256").update(signed).sign(privateKey, "base64");
  if (fault === "tamper") body += " "; // signature was computed over the original bytes
  const headers = {
    "content-type": "application/json",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": fault === "badcert" ? "https://evil.example.com/v1/notifications/certs/CERT-SIM" : `${ORIGIN}/v1/notifications/certs/CERT-SIM`,
    "paypal-transmission-id": transmissionId,
    "paypal-transmission-sig": sig,
    "paypal-transmission-time": time,
  };
  const attempts = fault === "replay" ? 2 : 1;
  const out = [];
  for (let i = 0; i < attempts; i++) {
    let status = 0;
    let text = "";
    try {
      const r = await fetch(WEBHOOK_URL, { method: "POST", headers, body, signal: AbortSignal.timeout(20_000) });
      status = r.status;
      text = (await r.text()).slice(0, 200);
    } catch (e) { text = String(e?.message ?? e); }
    const rec = { eventType, eventId: event.id, fault, attempt: i + 1, status, body: text };
    deliveries.push(rec);
    out.push(rec);
  }
  return out;
}

/* ---------------- routes ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const path = url.pathname;
  const m = (re) => re.exec(path);
  console.log(`${req.method} ${path}`);

  try {
    if (req.method === "GET" && path === "/sim/health") return send(res, 200, { ok: true, orders: orders.size });
    if (req.method === "POST" && path === "/sim/reset") { orders.clear(); invoices.clear(); idem.clear(); deliveries.length = 0; return send(res, 200, { ok: true }); }

    if (req.method === "GET" && path === "/v1/notifications/certs/CERT-SIM") {
      res.writeHead(200, { "content-type": "application/x-pem-file" });
      return res.end(CERT_PEM);
    }

    if (req.method === "POST" && path === "/v1/oauth2/token") {
      return send(res, 200, { access_token: "SIM-TOKEN", token_type: "Bearer", expires_in: 32400, scope: "sim" });
    }

    // Everything below needs a bearer token (any non-empty one).
    const isApi = path.startsWith("/v2/") || path.startsWith("/sim/orders");
    if (isApi && !/^Bearer\s+\S+/.test(req.headers.authorization ?? "") && !path.startsWith("/sim/")) {
      return send(res, 401, { name: "AUTHENTICATION_FAILURE", message: "Authentication failed due to invalid authentication credentials" });
    }

    /* ---- create order ---- */
    if (req.method === "POST" && path === "/v2/checkout/orders") {
      const rid = req.headers["paypal-request-id"];
      const key = rid ? `create:${rid}` : null;
      if (key && idem.has(key)) { const r = idem.get(key); return send(res, r.status, r.body); }

      const b = await readJson(req);
      const pu = b?.purchase_units?.[0];
      if (!pu?.amount?.breakdown?.item_total || !pu.items?.length) return send(res, 400, { name: "INVALID_REQUEST", details: [{ issue: "MISSING_REQUIRED_PARAMETER" }] });

      const itemsSum = pu.items.reduce((s, i) => s + cents(i.unit_amount.value) * Number(i.quantity), 0);
      const br = pu.amount.breakdown;
      const total = cents(br.item_total.value) + cents(br.tax_total?.value ?? "0.00") + cents(br.shipping?.value ?? "0.00");
      if (itemsSum !== cents(br.item_total.value) || total !== cents(pu.amount.value)) {
        return send(res, 422, unprocessable("AMOUNT_MISMATCH", "Should equal item_total + tax_total + shipping"));
      }
      if (pu.invoice_id && invoices.has(pu.invoice_id)) {
        const r = unprocessable("DUPLICATE_INVOICE_ID", "Duplicate Invoice ID detected.");
        return send(res, 422, r);
      }

      const id = `ORD-${randomUUID().slice(0, 12).toUpperCase()}`;
      orders.set(id, { id, status: "CREATED", intent: b.intent ?? "CAPTURE", purchase_units: b.purchase_units, captures: [], captureFault: "none" });
      if (pu.invoice_id) invoices.set(pu.invoice_id, id);
      const body = { id, status: "CREATED", links: [] };
      if (key) idem.set(key, { status: 201, body });
      return send(res, 201, body);
    }

    const g = m(/^\/v2\/checkout\/orders\/([^/]+)$/);
    if (req.method === "GET" && g) {
      const o = orders.get(g[1]);
      return o ? send(res, 200, publicOrder(o)) : send(res, 404, { name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID" }] });
    }

    /* ---- capture ---- */
    const c = m(/^\/v2\/checkout\/orders\/([^/]+)\/capture$/);
    if (req.method === "POST" && c) {
      const o = orders.get(c[1]);
      if (!o) return send(res, 404, { name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID" }] });
      const rid = req.headers["paypal-request-id"];
      const key = rid ? `capture:${o.id}:${rid}` : null;
      if (key && idem.has(key)) { const r = idem.get(key); return send(res, r.status, r.body); } // replay: no 2nd capture, no 2nd webhook

      if (o.status === "COMPLETED") return send(res, 422, unprocessable("ORDER_ALREADY_CAPTURED", "Order already captured"));
      if (o.status !== "APPROVED") return send(res, 422, unprocessable("ORDER_NOT_APPROVED", "Payer has not approved the order"));

      if (o.captureFault === "CARD_EXPIRED") return send(res, 422, unprocessable("CARD_EXPIRED", "The card on file has expired"));
      if (o.captureFault === "PROCESSOR_UNAVAILABLE") return send(res, 503, { name: "SERVICE_UNAVAILABLE", message: "Service Unavailable" });

      const pu = o.purchase_units[0];
      const capture = { id: `CAP-${randomUUID().slice(0, 12).toUpperCase()}`, status: "COMPLETED", amount: pu.amount && { currency_code: pu.amount.currency_code, value: pu.amount.value }, custom_id: pu.custom_id, invoice_id: pu.invoice_id, final_capture: true };
      o.captures.push(capture);
      o.status = "COMPLETED";
      const body = { ...publicOrder(o), purchase_units: [{ ...pu, payments: { captures: [capture] } }] };
      if (key) idem.set(key, { status: 201, body });
      setImmediate(() => deliver("PAYMENT.CAPTURE.COMPLETED", capture)); // async, like real PayPal
      return send(res, 201, body);
    }

    /* ---- simulator-only controls ---- */
    const ap = m(/^\/sim\/orders\/([^/]+)\/approve$/);
    if (req.method === "POST" && ap) {
      const o = orders.get(ap[1]);
      if (!o) return send(res, 404, { error: "no such order" });
      const b = (await readJson(req)) ?? {};
      o.captureFault = b.capture_fault ?? "none";
      o.status = "APPROVED";
      const result = await deliver("CHECKOUT.ORDER.APPROVED", publicOrder(o), b.webhook_fault ?? "none");
      return send(res, 200, { orderId: o.id, deliveries: result });
    }
    // Change/clear the capture fault WITHOUT re-firing the approval webhook (used to test exception re-triggers).
    const fl = m(/^\/sim\/orders\/([^/]+)\/fault$/);
    if (req.method === "POST" && fl) {
      const o = orders.get(fl[1]);
      if (!o) return send(res, 404, { error: "no such order" });
      o.captureFault = ((await readJson(req)) ?? {}).capture_fault ?? "none";
      return send(res, 200, { orderId: o.id, captureFault: o.captureFault });
    }
    const st = m(/^\/sim\/orders\/([^/]+)$/);
    if (req.method === "GET" && st) {
      const o = orders.get(st[1]);
      return o ? send(res, 200, { status: o.status, captures: o.captures.length, order: publicOrder(o) }) : send(res, 404, { error: "no such order" });
    }
    if (req.method === "GET" && path === "/sim/deliveries") return send(res, 200, deliveries);

    return send(res, 404, { name: "NOT_FOUND" });
  } catch (e) {
    console.error(e);
    return send(res, 500, { name: "INTERNAL_SERVER_ERROR", message: String(e?.message ?? e) });
  }
});

function publicOrder(o) {
  return { id: o.id, status: o.status, intent: o.intent, purchase_units: o.purchase_units };
}

server.listen(PORT, () => console.log(`PayPal SIMULATOR (not PayPal) on ${ORIGIN} -> webhooks to ${WEBHOOK_URL}`));
export { money };
