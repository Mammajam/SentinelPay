// End-to-end scenarios against the LOCAL PayPal simulator + the real app + real Neon.
//   npm run e2e:sim            (loads .env.local; needs DATABASE_URL)
// The scenario runner only knows base URLs, so the same flow can later be pointed at
// the real PayPal sandbox as a contract test (see docs/PAYPAL_SIMULATOR.md).
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { Policy } from "../src/lib/policy/schema.ts";
import { policyHash } from "../src/lib/policy/readback.ts";
import { activatePolicy, insertDraftPolicy } from "../src/lib/db/store.ts";
import { verifyStoredChain } from "../src/lib/db/audit.ts";
import { db } from "../src/lib/db/client.ts";
import { mitigationFor } from "../src/lib/paypal/errors.ts";

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL missing (run via npm run e2e:sim)"); process.exit(1); }

const SIM_PORT = 4010, APP_PORT = 3918;
const SIM = `http://localhost:${SIM_PORT}`, APP = `http://localhost:${APP_PORT}`;
const AGENT_KEY = randomUUID().replace(/-/g, "");
const childEnv = {
  ...process.env,
  SIM_PORT: String(SIM_PORT),
  SIM_WEBHOOK_URL: `${APP}/api/webhooks/paypal`,
  PAYPAL_BASE_URL: SIM,
  SIM_CERT_ORIGIN: SIM,
  PAYPAL_WEBHOOK_ID: "SIM-WEBHOOK-ID",
  PAYPAL_CLIENT_ID: "sim",
  PAYPAL_CLIENT_SECRET: "sim",
  SENTINEL_AGENT_KEYS: createHash("sha256").update(AGENT_KEY).digest("hex"),
};
// Make this process's PayPal client talk to the simulator too (scenario S12).
Object.assign(process.env, { PAYPAL_BASE_URL: SIM, PAYPAL_CLIENT_ID: "sim", PAYPAL_CLIENT_SECRET: "sim" });

/* ---------------- tiny harness ---------------- */
let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.log(`  ✖ ${name}${detail !== undefined ? `  -> ${JSON.stringify(detail)}` : ""}`); }
}
const section = (s: string) => console.log(`\n${s}`);
async function until<T>(fn: () => Promise<T | undefined | false>, ms = 15_000): Promise<T | undefined> {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 250)); }
  return undefined;
}

/* ---------------- processes ---------------- */
const procs: ChildProcess[] = [];
function start(cmd: string, args: string[], tag: string) {
  const p = spawn(cmd, args, { env: childEnv, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout?.on("data", () => {});
  p.stderr?.on("data", (d) => { if (process.env.E2E_VERBOSE) process.stderr.write(`[${tag}] ${d}`); });
  procs.push(p);
}
function stopAll() { for (const p of procs) { try { if (p.pid) process.kill(-p.pid, "SIGTERM"); } catch { /* already gone */ } } }
process.on("exit", stopAll);

/* ---------------- domain helpers ---------------- */
interface Delivery { eventType: string; status: number; body: string }
interface SimOrder { status: string; captures: number }

async function makePolicy(rules: unknown[]): Promise<string> {
  const compiled = Policy.parse({ version: 1, currency: "USD", rules });
  const hash = policyHash(compiled);
  const id = await insertDraftPolicy({ ownerId: "e2e", sourceText: "e2e scenario", compiled, hash, compiler: "e2e" });
  if (!(await activatePolicy(id, hash, "e2e"))) throw new Error("activation failed");
  return id;
}
const HAPPY = [{ kind: "max_total", amount: 120_000 }, { kind: "max_tax_shipping", amount: 15_000 }];

async function createOrder(o: { policyId: string; item: string; tax?: string; ship?: string; invoice?: string; total: string }) {
  const res = await fetch(`${SIM}/v2/checkout/orders`, {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json", "paypal-request-id": randomUUID() },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        custom_id: o.policyId,
        invoice_id: o.invoice ?? `INV-${randomUUID()}`,
        payee: { merchant_id: "MERCH1" },
        amount: { currency_code: "USD", value: o.total, breakdown: { item_total: { currency_code: "USD", value: o.item }, tax_total: { currency_code: "USD", value: o.tax ?? "80.00" }, shipping: { currency_code: "USD", value: o.ship ?? "20.00" } } },
        items: [{ name: "Laptop", sku: "LAP1", quantity: "1", unit_amount: { currency_code: "USD", value: o.item } }],
      }],
    }),
  });
  return { http: res.status, body: (await res.json()) as { id: string; details?: Array<{ issue: string }> } };
}
async function approve(orderId: string, body: Record<string, string> = {}) {
  const res = await fetch(`${SIM}/sim/orders/${orderId}/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return ((await res.json()) as { deliveries: Delivery[] }).deliveries;
}
const simOrder = async (id: string) => (await (await fetch(`${SIM}/sim/orders/${id}`)).json()) as SimOrder;
const audit = async (policyId: string) =>
  (await db().query("SELECT kind, payload FROM audit_log WHERE payload->>'policyId' = $1 ORDER BY seq", [policyId])).rows as Array<{ kind: string; payload: Record<string, unknown> }>;
const ledger = async (policyId: string) =>
  (await db().query("SELECT amount::int AS amount FROM spend_ledger WHERE policy_id = $1", [policyId])).rows as Array<{ amount: number }>;

const GOOD = { item: "1000.00", total: "1100.00" }; // 100000 + 8000 + 2000 = 110000 minor

async function run() {
  section("Booting simulator + app (next dev) ...");
  start("node", ["tools/paypal-sim/server.mjs"], "sim");
  start("npx", ["next", "dev", "-p", String(APP_PORT)], "app");
  check("simulator is up", Boolean(await until(async () => (await fetch(`${SIM}/sim/health`).catch(() => null))?.ok)));
  check("app is up", Boolean(await until(async () => (await fetch(APP).catch(() => null))?.ok, 120_000)));
  await fetch(`${SIM}/sim/reset`, { method: "POST" });

  section("S1  Happy path: within limits => inspect ALLOW => capture => ledger");
  const p1 = await makePolicy(HAPPY);
  const o1 = (await createOrder({ policyId: p1, ...GOOD })).body.id;
  const d1 = await approve(o1);
  check("webhook accepted (200)", d1[0]?.status === 200, d1[0]);
  const s1 = await simOrder(o1);
  check("order COMPLETED with exactly 1 capture", s1.status === "COMPLETED" && s1.captures === 1, s1);
  check("ledger has exactly 1 row of 110000", await until(async () => { const l = await ledger(p1); return l.length === 1 && l[0].amount === 110_000; }) !== undefined, await ledger(p1));
  // capture.recorded is written just after the ledger row (async webhook), so wait for it.
  await until(async () => (await audit(p1)).some((e) => e.kind === "capture.recorded"));
  const a1 = (await audit(p1)).map((e) => e.kind);
  check("audit: order.inspected, order.captured, capture.recorded", ["order.inspected", "order.captured", "capture.recorded"].every((k) => a1.includes(k)), a1);

  section("S2  Over limit => REQUIRE_REAUTH, NO capture");
  const p2 = await makePolicy(HAPPY);
  const o2 = (await createOrder({ policyId: p2, item: "1150.00", total: "1250.00" })).body.id;
  const d2 = await approve(o2);
  const a2 = await audit(p2);
  check("webhook handled (200)", d2[0]?.status === 200);
  check("decision REQUIRE_REAUTH", a2.find((e) => e.kind === "order.inspected")?.payload.decision === "REQUIRE_REAUTH", a2);
  const s2 = await simOrder(o2);
  check("NOT captured (status APPROVED, 0 captures)", s2.status === "APPROVED" && s2.captures === 0, s2);
  check("no ledger row", (await ledger(p2)).length === 0);

  section("S3-S5  Forged webhooks are rejected, nothing captured");
  for (const [fault, label] of [["tamper", "tampered body"], ["stale", "stale timestamp"], ["badcert", "untrusted cert URL"]] as const) {
    const pol = await makePolicy(HAPPY);
    const o = (await createOrder({ policyId: pol, ...GOOD })).body.id;
    const d = await approve(o, { webhook_fault: fault });
    const s = await simOrder(o);
    check(`${label}: 400`, d[0]?.status === 400, d[0]);
    check(`${label}: no capture`, s.captures === 0 && s.status === "APPROVED", s);
  }

  section("S6  Replayed webhook is processed once");
  const p6 = await makePolicy(HAPPY);
  const o6 = (await createOrder({ policyId: p6, ...GOOD })).body.id;
  const d6 = await approve(o6, { webhook_fault: "replay" });
  check("1st delivery processed, 2nd flagged replay", d6[0]?.status === 200 && !d6[0].body.includes("replay") && d6[1]?.body.includes('"replay":true'), d6);
  await until(async () => (await ledger(p6)).length === 1);
  check("exactly 1 capture and 1 ledger row", (await simOrder(o6)).captures === 1 && (await ledger(p6)).length === 1);

  section("S7  CARD_EXPIRED at capture => FAILED, invalidate token, no ledger");
  const p7 = await makePolicy(HAPPY);
  const o7 = (await createOrder({ policyId: p7, ...GOOD })).body.id;
  await approve(o7, { capture_fault: "CARD_EXPIRED" });
  const f7 = (await audit(p7)).find((e) => e.kind === "order.capture_failed");
  check("order.capture_failed with INVALIDATE_TOKEN, not ambiguous", (f7?.payload.action as { type?: string } | undefined)?.type === "INVALIDATE_TOKEN" && f7?.payload.ambiguous === false, f7?.payload);
  check("no ledger row", (await ledger(p7)).length === 0);

  section("S8  Processor 503 at capture => AMBIGUOUS, never blind-retried");
  const p8 = await makePolicy(HAPPY);
  const o8 = (await createOrder({ policyId: p8, ...GOOD })).body.id;
  await approve(o8, { capture_fault: "PROCESSOR_UNAVAILABLE" });
  const f8 = (await audit(p8)).find((e) => e.kind === "order.capture_failed");
  check("capture_failed flagged ambiguous", f8?.payload.ambiguous === true, f8?.payload);
  check("no ledger row", (await ledger(p8)).length === 0);

  section("S9  Unknown policy => DENY, no capture");
  const ghost = randomUUID();
  const o9 = (await createOrder({ policyId: ghost, ...GOOD })).body.id;
  await approve(o9);
  check("DENY audited", (await audit(ghost)).find((e) => e.kind === "order.inspected")?.payload.decision === "DENY");
  check("no capture", (await simOrder(o9)).captures === 0);

  section("S10 price_drift with no catalog baseline => DENY (fail-closed, open item O3)");
  const p10 = await makePolicy([...HAPPY, { kind: "price_drift", toleranceBps: 0, maxBaselineAgeSec: 86_400 }]);
  const o10 = (await createOrder({ policyId: p10, ...GOOD })).body.id;
  await approve(o10);
  check("DENY audited", (await audit(p10)).find((e) => e.kind === "order.inspected")?.payload.decision === "DENY");
  check("no capture", (await simOrder(o10)).captures === 0);

  section("S11 Duplicate invoice => 422, mitigation is LOOKUP (not blind retry)");
  const inv = `INV-${randomUUID()}`;
  const first = await createOrder({ policyId: p1, ...GOOD, invoice: inv });
  const dup = await createOrder({ policyId: p1, ...GOOD, invoice: inv });
  check("first create 201", first.http === 201);
  check("duplicate => 422 DUPLICATE_INVOICE_ID", dup.http === 422 && dup.body.details?.[0]?.issue === "DUPLICATE_INVOICE_ID", dup);
  check("mitigation = LOOKUP_EXISTING_ORDER", mitigationFor("ORDERS_V2", "DUPLICATE_INVOICE_ID").type === "LOOKUP_EXISTING_ORDER");

  section("S12 Double-capture protection (idempotency key + PayPal state)");
  const { captureOrder } = await import("../src/lib/paypal/capture.ts");
  const again = await captureOrder({ orderId: o1, policyId: p1 }); // SAME deterministic request id as the app used
  check("same request id => replayed result, still CAPTURED", again.status === "CAPTURED", again);
  const newAttempt = await captureOrder({ orderId: o1, policyId: p1, attempt: 1 }); // different key
  check("different request id => ORDER_ALREADY_CAPTURED (refused)", newAttempt.status === "FAILED" && newAttempt.issue === "ORDER_ALREADY_CAPTURED", newAttempt);
  check("simulator still shows exactly 1 capture", (await simOrder(o1)).captures === 1);

  section("S13 validate-cart API (agent key)");
  const cart = { cartId: "c-e2e", merchantId: "MERCH1", currency: "USD", lines: [{ sku: "LAP1", quantity: 1, unitPrice: 100_000 }], tax: 8_000, shipping: 2_000, total: 110_000 };
  const call = (key: string | null, body: unknown) => fetch(`${APP}/api/validate-cart`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
  check("no key => 401", (await call(null, { policyId: p1, cart })).status === 401);
  check("wrong key => 401", (await call("nope", { policyId: p1, cart })).status === 401);
  const ok = await (await call(AGENT_KEY, { policyId: p1, cart })).json() as { decision: string };
  check("in-limit cart => ALLOW", ok.decision === "ALLOW", ok);
  const over = await (await call(AGENT_KEY, { policyId: p1, cart: { ...cart, lines: [{ sku: "LAP1", quantity: 1, unitPrice: 115_000 }], total: 125_000 } })).json() as { decision: string };
  check("over-limit cart => REQUIRE_REAUTH", over.decision === "REQUIRE_REAUTH", over);
  const lie = await (await call(AGENT_KEY, { policyId: p1, cart: { ...cart, total: 1 } })).json() as { decision: string };
  check("agent lies about total => DENY", lie.decision === "DENY", lie);
  const ghostRes = await call(AGENT_KEY, { policyId: randomUUID(), cart });
  check("unknown policy => DENY (403)", ghostRes.status === 403 && ((await ghostRes.json()) as { decision: string }).decision === "DENY");

  section("S14 Concurrency: 10 parallel approvals on one policy");
  const p14 = await makePolicy(HAPPY);
  const ids = await Promise.all(Array.from({ length: 10 }, async () => (await createOrder({ policyId: p14, ...GOOD })).body.id));
  await Promise.all(ids.map((id) => approve(id)));
  const settled = await until(async () => (await ledger(p14)).length === 10, 30_000);
  check("10 captures, 10 ledger rows, no duplicates", Boolean(settled), (await ledger(p14)).length);
  check("every order captured exactly once", (await Promise.all(ids.map(simOrder))).every((s) => s.captures === 1));

  section("S15 Audit chain integrity after everything above (incl. concurrent writes)");
  check("hash chain verifies end-to-end", (await verifyStoredChain()) === null, await verifyStoredChain());
}

try { await run(); }
catch (e) { failed++; console.error("RUNNER ERROR:", e); }
finally {
  stopAll();
  await db().end().catch(() => {});
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
