import { test } from "node:test";
import assert from "node:assert/strict";
import { devCertOrigin, isTrustedCertUrl } from "../src/lib/paypal/webhook.ts";
import { baseUrl } from "../src/lib/paypal/client.ts";
import { captureOrder } from "../src/lib/paypal/capture.ts";

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
