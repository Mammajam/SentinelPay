import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { evaluate } from "../src/lib/policy/evaluate.ts";
import { readback, policyHash } from "../src/lib/policy/readback.ts";
import { crc32, isTrustedCertUrl, verifyWebhook } from "../src/lib/paypal/webhook.ts";
import { requestId } from "../src/lib/paypal/idempotency.ts";
import { mitigationFor } from "../src/lib/paypal/errors.ts";
import { makeEntry, verifyChain } from "../src/lib/audit/chain.ts";

const now = new Date("2026-10-06T12:00:00Z");
const ctx = { now, spentInWindow: () => 0 };
const fresh = "2026-10-06T10:00:00Z";

// "Buy this laptop only if tax+shipping < $150 and total < $1,200", no drift.
const policy = {
  version: 1, currency: "USD",
  rules: [
    { kind: "max_total", amount: 120_000 },
    { kind: "max_tax_shipping", amount: 15_000 },
    { kind: "price_drift", toleranceBps: 0, maxBaselineAgeSec: 86_400 },
  ],
};
const cart = (over: Record<string, unknown> = {}) => ({
  cartId: "c1", merchantId: "m1", currency: "USD",
  lines: [{ sku: "LAP1", quantity: 1, unitPrice: 100_000, baselineUnitPrice: 100_000, baselineFetchedAt: fresh }],
  tax: 8_000, shipping: 2_000, total: 110_000, ...over,
});

test("allows a cart inside every limit", () => {
  assert.equal(evaluate(policy, cart(), ctx).decision, "ALLOW");
});
test("total over ceiling => REQUIRE_REAUTH", () => {
  const c = cart({ lines: [{ sku: "LAP1", quantity: 1, unitPrice: 115_000, baselineUnitPrice: 115_000, baselineFetchedAt: fresh }], total: 125_000 });
  assert.equal(evaluate(policy, c, ctx).decision, "REQUIRE_REAUTH");
});
test("price drift of even 1 cent => REQUIRE_REAUTH", () => {
  const c = cart({ lines: [{ sku: "LAP1", quantity: 1, unitPrice: 100_001, baselineUnitPrice: 100_000, baselineFetchedAt: fresh }], total: 110_001 });
  const r = evaluate(policy, c, ctx);
  assert.equal(r.decision, "REQUIRE_REAUTH");
  assert.equal(r.violations[0].code, "PRICE_DRIFT");
});
test("missing or stale baseline is DENY, not 'no drift'", () => {
  const noBase = cart({ lines: [{ sku: "LAP1", quantity: 1, unitPrice: 100_000 }] });
  assert.equal(evaluate(policy, noBase, ctx).decision, "DENY");
  const stale = cart({ lines: [{ sku: "LAP1", quantity: 1, unitPrice: 100_000, baselineUnitPrice: 100_000, baselineFetchedAt: "2026-09-01T00:00:00Z" }] });
  assert.equal(evaluate(policy, stale, ctx).decision, "DENY");
});
test("asserted total that does not reconcile => DENY", () => {
  assert.equal(evaluate(policy, cart({ total: 1 }), ctx).decision, "DENY");
});
test("garbage / unknown rule / currency mismatch => DENY (fail-closed)", () => {
  assert.equal(evaluate(null, cart(), ctx).decision, "DENY");
  assert.equal(evaluate({ ...policy, rules: [{ kind: "wire_money" }] }, cart(), ctx).decision, "DENY");
  assert.equal(evaluate(policy, cart({ currency: "EUR" }), ctx).decision, "DENY");
});
test("hard violations outrank soft ones", () => {
  const p = { ...policy, rules: [...policy.rules, { kind: "merchant_allowlist", merchantIds: ["other"] }] };
  assert.equal(evaluate(p, cart(), ctx).decision, "DENY");
});
test("cumulative budget uses the ledger; unreadable ledger => DENY", () => {
  const p = { ...policy, rules: [{ kind: "cumulative_budget", amount: 200_000, windowDays: 30 }] };
  assert.equal(evaluate(p, cart(), { now, spentInWindow: () => 100_000 }).decision, "REQUIRE_REAUTH");
  assert.equal(evaluate(p, cart(), { now, spentInWindow: () => NaN }).decision, "DENY");
});
test("readback is deterministic and hash is key-order independent", () => {
  const a = { version: 1 as const, currency: "USD", rules: [{ kind: "max_total" as const, amount: 120_000 }] };
  assert.match(readback(a)[0], /\$1,200\.00/);
  const b = JSON.parse('{"rules":[{"amount":120000,"kind":"max_total"}],"currency":"USD","version":1}');
  assert.equal(policyHash(a), policyHash(b));
});

test("crc32 known vector", () => assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926));
test("cert URL allowlist", () => {
  assert.ok(isTrustedCertUrl("https://api.paypal.com/v1/notifications/certs/CERT-1"));
  assert.ok(isTrustedCertUrl("https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1"));
  for (const bad of [
    "http://api.paypal.com/v1/notifications/certs/x",
    "https://paypal.com.evil.io/v1/notifications/certs/x",
    "https://evilpaypal.com/v1/notifications/certs/x",
    "https://api.paypal.com@evil.io/v1/notifications/certs/x",
    "https://api.paypal.com/other",
    "not a url",
  ]) assert.equal(isTrustedCertUrl(bad), false, bad);
});
test("webhook: valid signature passes; tampered body, bad URL, stale time fail", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const body = Buffer.from('{"event_type":"CHECKOUT.ORDER.APPROVED"}');
  const time = now.toISOString();
  const sig = createSign("RSA-SHA256").update(`T1|${time}|WH1|${crc32(body)}`).sign(privateKey, "base64");
  const h = { authAlgo: "SHA256withRSA", certUrl: "https://api.paypal.com/v1/notifications/certs/C", transmissionId: "T1", transmissionSig: sig, transmissionTime: time };
  const o = { webhookId: "WH1", fetchCertPem: async () => pem, now };
  assert.deepEqual(await verifyWebhook(body, h, o), { ok: true });
  assert.equal((await verifyWebhook(Buffer.from("{}"), h, o)).ok, false);
  assert.equal((await verifyWebhook(body, { ...h, certUrl: "https://evil.io/v1/notifications/certs/C" }, o)).ok, false);
  assert.equal((await verifyWebhook(body, h, { ...o, now: new Date("2026-10-06T13:00:00Z") })).ok, false);
});

test("idempotency key is stable per operation and changes with attempt", () => {
  const a = requestId({ policyId: "p", cartId: "c", operation: "capture" });
  assert.equal(a, requestId({ policyId: "p", cartId: "c", operation: "capture" }));
  assert.notEqual(a, requestId({ policyId: "p", cartId: "c", operation: "capture", attempt: 1 }));
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});
test("mitigations: duplicate invoice => lookup (not retry); unknown => HALT", () => {
  assert.equal(mitigationFor("ORDERS_V2", "DUPLICATE_INVOICE_ID").type, "LOOKUP_EXISTING_ORDER");
  assert.equal(mitigationFor("PRICING_ERROR", "TAX_CALCULATION_FAILED").type, "HALT");
  assert.equal(mitigationFor("X", "Y").type, "HALT");
});

test("audit chain detects tampering and deletion", () => {
  const e1 = makeEntry(null, "a", { n: 1 });
  const e2 = makeEntry(e1, "b", { n: 2 });
  const e3 = makeEntry(e2, "c", { n: 3 });
  assert.equal(verifyChain([e1, e2, e3]), null);
  assert.equal(verifyChain([e1, { ...e2, payload: { n: 99 } }, e3]), 2);
  assert.equal(verifyChain([e1, e3]), 3);
});
