import { test } from "node:test";
import assert from "node:assert/strict";
import { devCertOrigin, isTrustedCertUrl } from "../src/lib/paypal/webhook.ts";
import { baseUrl } from "../src/lib/paypal/client.ts";
import { captureOrder } from "../src/lib/paypal/capture.ts";
import { orderToCart } from "../src/lib/paypal/orders.ts";
import { evaluate } from "../src/lib/policy/evaluate.ts";

const dev = { SIM_CERT_ORIGIN: "http://localhost:4010", PAYPAL_BASE_URL: "http://localhost:4010", NODE_ENV: "development" };

test("simulator cert origin is enabled only for a provably local dev setup", () => {
  assert.equal(devCertOrigin(dev), "http://localhost:4010");
  assert.equal(devCertOrigin({ ...dev, NODE_ENV: "production" }), undefined, "never in production");
  assert.equal(devCertOrigin({ ...dev, PAYPAL_BASE_URL: "https://api-m.sandbox.paypal.com" }), undefined, "base url must be loopback");
  assert.equal(devCertOrigin({ ...dev, SIM_CERT_ORIGIN: "http://evil.example.com" }), undefined, "cert origin must be loopback");
  assert.equal(devCertOrigin({ ...dev, SIM_CERT_ORIGIN: "https://localhost:4010" }), undefined, "http only");
  assert.equal(devCertOrigin({ ...dev, SIM_CERT_ORIGIN: undefined }), undefined);
  assert.equal(devCertOrigin({ ...dev, SIM_CERT_ORIGIN: "not a url" }), undefined);
});

test("dev origin never widens trust to other hosts or paths", () => {
  const o = "http://localhost:4010";
  assert.ok(isTrustedCertUrl("http://localhost:4010/v1/notifications/certs/CERT-SIM", o));
  assert.equal(isTrustedCertUrl("http://localhost:4010/v1/notifications/certs/CERT-SIM"), false, "off by default");
  assert.equal(isTrustedCertUrl("http://localhost:4011/v1/notifications/certs/x", o), false, "other port");
  assert.equal(isTrustedCertUrl("http://localhost:4010/other", o), false, "other path");
  assert.equal(isTrustedCertUrl("http://localhost:4010@evil.io/v1/notifications/certs/x", o), false, "userinfo trick");
});

test("live PayPal hosts are refused unless explicitly allowed", () => {
  assert.throws(() => baseUrl({ PAYPAL_BASE_URL: "https://api-m.paypal.com" }), /live PayPal/);
  assert.throws(() => baseUrl({ PAYPAL_BASE_URL: "https://api.paypal.com/" }), /live PayPal/);
  assert.equal(baseUrl({ PAYPAL_BASE_URL: "https://api-m.paypal.com", PAYPAL_ALLOW_LIVE: "1" }), "https://api-m.paypal.com");
  assert.equal(baseUrl({}), "https://api-m.sandbox.paypal.com");
  assert.equal(baseUrl({ PAYPAL_BASE_URL: "http://localhost:4010/" }), "http://localhost:4010");
});

const resp = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
const A = { orderId: "ORD-1", policyId: "11111111-1111-4111-8111-111111111111" };

test("capture: COMPLETED capture => CAPTURED, with a deterministic request id", async () => {
  const ok = resp(201, { purchase_units: [{ payments: { captures: [{ id: "CAP-1", status: "COMPLETED" }] } }] });
  const a = await captureOrder(A, ok);
  const b = await captureOrder(A, ok);
  assert.equal(a.status, "CAPTURED");
  assert.equal(a.requestId, b.requestId);
});
test("capture: 2xx without a COMPLETED capture is NOT success", async () => {
  const r = await captureOrder(A, resp(201, { purchase_units: [{ payments: { captures: [{ id: "CAP-1", status: "PENDING" }] } }] }));
  assert.equal(r.status, "FAILED");
});
test("capture: 422 CARD_EXPIRED => invalidate token, not ambiguous", async () => {
  const r = await captureOrder(A, resp(422, { details: [{ issue: "CARD_EXPIRED" }] }));
  assert.ok(r.status === "FAILED" && r.action.type === "INVALIDATE_TOKEN" && !r.ambiguous);
});
test("capture: unknown 422 issue => HALT", async () => {
  const r = await captureOrder(A, resp(422, { details: [{ issue: "SOMETHING_NEW" }] }));
  assert.ok(r.status === "FAILED" && r.action.type === "HALT");
});
test("capture: 5xx and transport errors are AMBIGUOUS (never blind-retry)", async () => {
  const r5 = await captureOrder(A, resp(503, {}));
  assert.ok(r5.status === "FAILED" && r5.ambiguous);
  const rt = await captureOrder(A, async () => { throw new Error("socket hang up"); });
  assert.ok(rt.status === "FAILED" && rt.ambiguous && rt.http === 0);
});

/* ---- findings from the APIMatic SDK-map verification (docs/APIMATIC_VERIFICATION.md) ---- */
test("capture asks PayPal for the FULL representation (PayPal's default is return=minimal)", async () => {
  let seen: { prefer?: string; requestId?: string } = {};
  const call = async (_path: string, init?: { prefer?: string; requestId?: string }) => {
    seen = { prefer: init?.prefer, requestId: init?.requestId };
    return new Response(JSON.stringify({ purchase_units: [{ payments: { captures: [{ id: "CAP-1", status: "COMPLETED" }] } }] }), { status: 201 });
  };
  const r = await captureOrder({ orderId: "O", policyId: "11111111-1111-4111-8111-111111111111" }, call as never);
  assert.equal(r.status, "CAPTURED");
  assert.equal(seen.prefer, "return=representation");
  assert.ok(seen.requestId);
});
test("a MINIMAL capture response ({id,status,links}) is never treated as success (we cannot see the capture status)", async () => {
  const r = await captureOrder({ orderId: "O", policyId: "11111111-1111-4111-8111-111111111111" }, (async () => new Response(JSON.stringify({ id: "O", status: "COMPLETED", links: [] }), { status: 201 })) as never);
  assert.ok(r.status === "FAILED" && r.ambiguous === true, "must reconcile, not assume");
});
test("a COMPLETED order whose capture is DECLINED or PENDING is not a success", async () => {
  for (const status of ["DECLINED", "PENDING", "FAILED"]) {
    const r = await captureOrder({ orderId: "O", policyId: "11111111-1111-4111-8111-111111111111" }, (async () => new Response(JSON.stringify({ status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "C", status }] } }] }), { status: 201 })) as never);
    assert.equal(r.status, "FAILED", status);
  }
});

const money = (value: string) => ({ currency_code: "USD", value });
const order = (breakdown: Record<string, unknown>, value: string) => ({
  id: "ORD-1",
  purchase_units: [{ custom_id: "pol", payee: { merchant_id: "M" }, items: [{ name: "n", sku: "S", quantity: "1", unit_amount: money("1000.00") }], amount: { currency_code: "USD", value, breakdown: { item_total: money("1000.00"), ...breakdown } } }],
});
const policy = { version: 1, currency: "USD", rules: [{ kind: "max_total", amount: 120_000 }, { kind: "max_tax_shipping", amount: 15_000 }] };
const ctx = { now: new Date("2026-10-20T12:00:00Z"), spentInWindow: () => 0 };

test("orderToCart reads the full PayPal breakdown and the evaluator reconciles it (handling, insurance, discounts)", () => {
  // 1000 + 80 tax + 20 ship + 10 handling + 5 insurance - 5 ship discount - 50 discount = 1060
  const o = order({ tax_total: money("80.00"), shipping: money("20.00"), handling: money("10.00"), insurance: money("5.00"), shipping_discount: money("5.00"), discount: money("50.00") }, "1060.00");
  const { cart } = orderToCart(o as never);
  assert.deepEqual([cart.handling, cart.insurance, cart.shippingDiscount, cart.discount, cart.total], [1000, 500, 500, 5000, 106000]);
  assert.equal(evaluate(policy, cart, ctx).decision, "ALLOW");
});
test("ignoring a discount PayPal applied would not reconcile: DENY (fail closed), not a silent pass", () => {
  const { cart } = orderToCart(order({ tax_total: money("80.00"), shipping: money("20.00"), discount: money("50.00") }, "1050.00") as never);
  assert.equal(evaluate(policy, { ...cart, discount: 0 }, ctx).decision, "DENY", "lying about the discount breaks reconciliation");
  assert.equal(evaluate(policy, cart, ctx).decision, "ALLOW", "the honest cart reconciles");
});
test("handling and insurance count toward the tax+shipping cap; discounts never loosen it", () => {
  const { cart } = orderToCart(order({ tax_total: money("80.00"), shipping: money("20.00"), handling: money("60.00"), discount: money("200.00") }, "960.00") as never);
  const r = evaluate(policy, cart, ctx); // charges 160 > 150 even though a big discount keeps the total low
  assert.equal(r.decision, "REQUIRE_REAUTH");
  assert.ok(r.violations.some((v) => v.code === "TAX_SHIPPING_EXCEEDED"));
});
test("a breakdown component in a different currency is refused (cannot reconcile)", () => {
  assert.throws(() => orderToCart(order({ tax_total: { currency_code: "EUR", value: "80.00" }, shipping: money("20.00") }, "1100.00") as never), /mixed currencies/);
});
