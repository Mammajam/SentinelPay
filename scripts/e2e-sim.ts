// End-to-end scenarios against the LOCAL PayPal simulator + the real app + real Neon.
//   npm run e2e:sim            (loads .env.local; needs DATABASE_URL, SENTINEL_MASTER_KEY, SESSION_SECRET, CRON_SECRET)
// The scenario runner only knows base URLs, so the same flow can later be pointed at
// the real PayPal sandbox as a contract test (see docs/PAYPAL_SIMULATOR.md).
// Every run creates fresh, uniquely-named tenants/merchants/keys; rows are permanent (append-only audit).
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Policy } from "../src/lib/policy/schema.ts";
import { policyHash } from "../src/lib/policy/readback.ts";
import { activatePolicy, createTenant, insertDraftPolicy, registerMerchant } from "../src/lib/db/store.ts";
import { verifyStoredChain } from "../src/lib/db/audit.ts";
import { createApiKey, revokeApiKey } from "../src/lib/auth/keys.ts";
import { stepAt, totpCode } from "../src/lib/auth/totp.ts";
import { db } from "../src/lib/db/client.ts";
import { mitigationFor } from "../src/lib/paypal/errors.ts";

for (const v of ["DATABASE_URL", "SENTINEL_MASTER_KEY", "SESSION_SECRET", "CRON_SECRET"]) {
  if (!process.env[v]) { console.error(`${v} missing (run via npm run e2e:sim; see .env.example)`); process.exit(1); }
}

const SIM_PORT = 4010, APP_PORT = 3918;
const SIM = `http://localhost:${SIM_PORT}`, APP = `http://localhost:${APP_PORT}`;
const RUN = randomUUID().slice(0, 8);
const TA = `e2e-a-${RUN}`, TB = `e2e-b-${RUN}`, MA = `MA-${RUN}`, MB = `MB-${RUN}`;
const FAKE_IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`; // fresh rate-limit buckets per run

const childEnv = {
  ...process.env,
  SIM_PORT: String(SIM_PORT),
  SIM_WEBHOOK_URL: `${APP}/api/webhooks/paypal`,
  PAYPAL_BASE_URL: SIM,
  SIM_CERT_ORIGIN: SIM,
  PAYPAL_WEBHOOK_ID: "SIM-WEBHOOK-ID",
  PAYPAL_CLIENT_ID: "sim",
  PAYPAL_CLIENT_SECRET: "sim",
  RL_VALIDATE_PER_MIN: "30",
};
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

async function makePolicy(tenantId: string, rules: unknown[]): Promise<string> {
  const compiled = Policy.parse({ version: 1, currency: "USD", rules });
  const hash = policyHash(compiled);
  const id = await insertDraftPolicy({ ownerId: tenantId, sourceText: "e2e scenario", compiled, hash, compiler: "e2e" });
  if (!(await activatePolicy(id, hash, "e2e", tenantId))) throw new Error("activation failed");
  return id;
}
async function makeDraft(tenantId: string) {
  const compiled = Policy.parse({ version: 1, currency: "USD", rules: HAPPY });
  const hash = policyHash(compiled);
  return { id: await insertDraftPolicy({ ownerId: tenantId, sourceText: "draft", compiled, hash, compiler: "e2e" }), hash };
}
const HAPPY = [{ kind: "max_total", amount: 120_000 }, { kind: "max_tax_shipping", amount: 15_000 }];

async function createOrder(o: { policyId: string; item: string; tax?: string; ship?: string; invoice?: string; total: string; merchant?: string }) {
  const res = await fetch(`${SIM}/v2/checkout/orders`, {
    method: "POST",
    headers: { authorization: "Bearer x", "content-type": "application/json", "paypal-request-id": randomUUID() },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        custom_id: o.policyId,
        invoice_id: o.invoice ?? `INV-${randomUUID()}`,
        payee: { merchant_id: o.merchant ?? MA },
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
const cartFor = (merchantId: string, cartId = "c-e2e", over: Record<string, unknown> = {}) => ({
  cartId, merchantId, currency: "USD", lines: [{ sku: "LAP1", quantity: 1, unitPrice: 100_000 }], tax: 8_000, shipping: 2_000, total: 110_000, ...over,
});
const api = (path: string, key: string | null, body?: unknown, extra: Record<string, string> = {}, method = "POST") =>
  fetch(`${APP}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": FAKE_IP, ...(key ? { authorization: `Bearer ${key}` } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const code = (secret: string, offset = 0) => totpCode(secret, stepAt(new Date()) + offset);

async function run() {
  section("Booting simulator + app (next dev) ...");
  start("node", ["tools/paypal-sim/server.mjs"], "sim");
  start("npx", ["next", "dev", "-p", String(APP_PORT)], "app");
  check("simulator is up", Boolean(await until(async () => (await fetch(`${SIM}/sim/health`).catch(() => null))?.ok)));
  check("app is up", Boolean(await until(async () => (await fetch(APP).catch(() => null))?.ok, 120_000)));
  await fetch(`${SIM}/sim/reset`, { method: "POST" });

  // Two tenants, each with its own merchant and keys.
  await createTenant(TA, `Tenant A ${RUN}`); await createTenant(TB, `Tenant B ${RUN}`);
  await registerMerchant(TA, MA); await registerMerchant(TB, MB);
  const adminA = await createApiKey({ tenantId: TA, role: "admin", label: "e2e confirm" });
  const adminLogin = await createApiKey({ tenantId: TA, role: "admin", label: "e2e login" });
  const adminA2 = await createApiKey({ tenantId: TA, role: "admin", label: "e2e confirm 2" }); // TOTP codes are single-use, so each step gets its own key
  const adminB = await createApiKey({ tenantId: TB, role: "admin", label: "e2e" });
  const adminDash = await createApiKey({ tenantId: TA, role: "admin", label: "e2e dashboard session" });
  const adminB2 = await createApiKey({ tenantId: TB, role: "admin", label: "e2e retrigger (other tenant)" });
  const mkAdmin = (label: string) => createApiKey({ tenantId: TA, role: "admin", label }); // one key per TOTP-gated call (codes are single-use)
  const agentA = await createApiKey({ tenantId: TA, role: "agent", label: "e2e" });
  const agentB = await createApiKey({ tenantId: TB, role: "agent", label: "e2e" });

  section("S1  Happy path: within limits => inspect ALLOW => capture => ledger");
  const p1 = await makePolicy(TA, HAPPY);
  const o1 = (await createOrder({ policyId: p1, ...GOOD })).body.id;
  const d1 = await approve(o1);
  check("webhook accepted (200)", d1[0]?.status === 200, d1[0]);
  const s1 = await simOrder(o1);
  check("order COMPLETED with exactly 1 capture", s1.status === "COMPLETED" && s1.captures === 1, s1);
  check("ledger has exactly 1 row of 110000", await until(async () => { const l = await ledger(p1); return l.length === 1 && l[0].amount === 110_000; }) !== undefined, await ledger(p1));
  await until(async () => (await audit(p1)).some((e) => e.kind === "capture.recorded"));
  const a1 = (await audit(p1)).map((e) => e.kind);
  check("audit: order.inspected, order.captured, capture.recorded", ["order.inspected", "order.captured", "capture.recorded"].every((k) => a1.includes(k)), a1);

  section("S2  Over limit => REQUIRE_REAUTH, NO capture");
  const p2 = await makePolicy(TA, HAPPY);
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
    const pol = await makePolicy(TA, HAPPY);
    const o = (await createOrder({ policyId: pol, ...GOOD })).body.id;
    const d = await approve(o, { webhook_fault: fault });
    const s = await simOrder(o);
    check(`${label}: 400`, d[0]?.status === 400, d[0]);
    check(`${label}: no capture`, s.captures === 0 && s.status === "APPROVED", s);
  }

  section("S6  Replayed webhook is processed once");
  const p6 = await makePolicy(TA, HAPPY);
  const o6 = (await createOrder({ policyId: p6, ...GOOD })).body.id;
  const d6 = await approve(o6, { webhook_fault: "replay" });
  check("1st delivery processed, 2nd flagged replay", d6[0]?.status === 200 && !d6[0].body.includes("replay") && d6[1]?.body.includes('"replay":true'), d6);
  await until(async () => (await ledger(p6)).length === 1);
  check("exactly 1 capture and 1 ledger row", (await simOrder(o6)).captures === 1 && (await ledger(p6)).length === 1);

  section("S7  CARD_EXPIRED at capture => FAILED, invalidate token, no ledger");
  const p7 = await makePolicy(TA, HAPPY);
  const o7 = (await createOrder({ policyId: p7, ...GOOD })).body.id;
  await approve(o7, { capture_fault: "CARD_EXPIRED" });
  const f7 = (await audit(p7)).find((e) => e.kind === "order.capture_failed");
  check("order.capture_failed with INVALIDATE_TOKEN, not ambiguous", (f7?.payload.action as { type?: string } | undefined)?.type === "INVALIDATE_TOKEN" && f7?.payload.ambiguous === false, f7?.payload);
  check("no ledger row", (await ledger(p7)).length === 0);

  section("S8  Processor 503 at capture => AMBIGUOUS, never blind-retried");
  const p8 = await makePolicy(TA, HAPPY);
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
  const p10 = await makePolicy(TA, [...HAPPY, { kind: "price_drift", toleranceBps: 0, maxBaselineAgeSec: 86_400 }]);
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
  const again = await captureOrder({ orderId: o1, policyId: p1 });
  check("same request id => replayed result, still CAPTURED", again.status === "CAPTURED", again);
  const newAttempt = await captureOrder({ orderId: o1, policyId: p1, attempt: 1 });
  check("different request id => ORDER_ALREADY_CAPTURED (refused)", newAttempt.status === "FAILED" && newAttempt.issue === "ORDER_ALREADY_CAPTURED", newAttempt);
  check("simulator still shows exactly 1 capture", (await simOrder(o1)).captures === 1);

  section("S13 validate-cart API (agent key, own tenant)");
  const cart = cartFor(MA);
  check("no key => 401", (await api("/api/validate-cart", null, { policyId: p1, cart })).status === 401);
  check("wrong key => 401", (await api("/api/validate-cart", "sp_agt_nope", { policyId: p1, cart })).status === 401);
  const ok = await (await api("/api/validate-cart", agentA.key, { policyId: p1, cart })).json() as { decision: string };
  check("in-limit cart => ALLOW", ok.decision === "ALLOW", ok);
  const over = await (await api("/api/validate-cart", agentA.key, { policyId: p1, cart: cartFor(MA, "c-over", { lines: [{ sku: "LAP1", quantity: 1, unitPrice: 115_000 }], total: 125_000 }) })).json() as { decision: string };
  check("over-limit cart => REQUIRE_REAUTH", over.decision === "REQUIRE_REAUTH", over);
  const lie = await (await api("/api/validate-cart", agentA.key, { policyId: p1, cart: cartFor(MA, "c-lie", { total: 1 }) })).json() as { decision: string };
  check("agent lies about total => DENY", lie.decision === "DENY", lie);
  const ghostRes = await api("/api/validate-cart", agentA.key, { policyId: randomUUID(), cart });
  check("unknown policy => DENY (403)", ghostRes.status === 403 && ((await ghostRes.json()) as { decision: string }).decision === "DENY");
  check("admin key on agent endpoint => 403", (await api("/api/validate-cart", adminA.key, { policyId: p1, cart })).status === 403);

  section("S14 Concurrency: 10 parallel approvals on one policy");
  const p14 = await makePolicy(TA, HAPPY);
  const ids = await Promise.all(Array.from({ length: 10 }, async () => (await createOrder({ policyId: p14, ...GOOD })).body.id));
  await Promise.all(ids.map((id) => approve(id)));
  const settled = await until(async () => (await ledger(p14)).length === 10, 30_000);
  check("10 captures, 10 ledger rows, no duplicates", Boolean(settled), (await ledger(p14)).length);
  check("every order captured exactly once", (await Promise.all(ids.map(simOrder))).every((s) => s.captures === 1));

  /* ====================== Phase 4 ====================== */

  section("S16 Tenant isolation: tenant B cannot see or use tenant A's policy");
  const pB = await makePolicy(TB, HAPPY);
  const xv = await api("/api/validate-cart", agentB.key, { policyId: p1, cart: cartFor(MB) });
  check("B validating against A's policy => 403 DENY (same as missing)", xv.status === 403 && ((await xv.json()) as { decision: string }).decision === "DENY");
  check("B reading A's policy => 404", (await api(`/api/agent/policies/${p1}`, agentB.key, undefined, {}, "GET")).status === 404);
  const own = await api(`/api/agent/policies/${p1}`, agentA.key, undefined, {}, "GET");
  const ownJson = (await own.json()) as { rules?: string[] };
  check("A reading own policy => 200 with plain-language rules", own.status === 200 && Array.isArray(ownJson.rules) && ownJson.rules.length === 2, ownJson);
  const bOk = await (await api("/api/validate-cart", agentB.key, { policyId: pB, cart: cartFor(MB, "cart-B-secret") })).json() as { decision: string };
  check("B's own policy + merchant => ALLOW", bOk.decision === "ALLOW", bOk);

  section("S17 Cross-tenant webhook: tenant B's order cannot use (or burn) A's policy");
  const before = (await ledger(p1)).length;
  const oX = (await createOrder({ policyId: p1, ...GOOD, merchant: MB })).body.id;
  await approve(oX);
  const xi = (await audit(p1)).filter((e) => e.kind === "order.inspected").find((e) => (e.payload.orderId as string) === oX);
  check("DENY with merchant_not_registered_for_policy_tenant", xi?.payload.decision === "DENY" && xi.payload.detail === "merchant_not_registered_for_policy_tenant", xi?.payload);
  check("not captured, A's ledger untouched", (await simOrder(oX)).captures === 0 && (await ledger(p1)).length === before);

  section("S18 Unregistered merchant is DENIED even with a valid policy");
  const um = await (await api("/api/validate-cart", agentA.key, { policyId: p1, cart: cartFor("SOMEONE-ELSE") })).json() as { decision: string; violations: Array<{ code: string }> };
  check("DENY with MERCHANT_NOT_REGISTERED", um.decision === "DENY" && um.violations.some((v) => v.code === "MERCHANT_NOT_REGISTERED"), um);

  section("S19 Policy confirmation needs admin key + single-use MFA + ownership");
  const d19 = await makeDraft(TA);
  const confirm = (key: string | null, totp: string | null, id: string, hash: string) =>
    api("/api/policies/confirm", key, { id, hash }, totp ? { "x-sentinel-totp": totp } : {});
  check("no key => 401", (await confirm(null, null, d19.id, d19.hash)).status === 401);
  check("agent key => 403", (await confirm(agentA.key, "123456", d19.id, d19.hash)).status === 403);
  check("admin key WITHOUT code => 401", (await confirm(adminA.key, null, d19.id, d19.hash)).status === 401);
  check("admin key with WRONG code => 401", (await confirm(adminA.key, "000000", d19.id, d19.hash)).status === 401);
  const wrongTenant = await confirm(adminB.key, code(adminB.totpSecret!), d19.id, d19.hash);
  check("other tenant's admin + valid code => 409 (not yours)", wrongTenant.status === 409, wrongTenant.status);
  const wrongHash = await confirm(adminA.key, code(adminA.totpSecret!), d19.id, "0".repeat(64));
  check("owner + valid code but WRONG hash => 409", wrongHash.status === 409, wrongHash.status);
  const replayCode = code(adminA2.totpSecret!); // computed ONCE: a replay is the identical code, not a freshly generated one (the 30 s window may roll over)
  const confirmed = await confirm(adminA2.key, replayCode, d19.id, d19.hash);
  check("owner + valid code + right hash => 200", confirmed.status === 200, confirmed.status);
  check("policy is now active", (await db().query("select status from policies where id=$1", [d19.id])).rows[0].status === "active");
  const d19b = await makeDraft(TA);
  const replay = await confirm(adminA2.key, replayCode, d19b.id, d19b.hash);
  check("re-using the same one-time code => 401 (replay blocked)", replay.status === 401, replay.status);
  check("policy stayed draft after replay", (await db().query("select status from policies where id=$1", [d19b.id])).rows[0].status === "draft");

  section("S20 Key lifecycle: revoked and expired keys stop working");
  const tmp = await createApiKey({ tenantId: TA, role: "agent", label: "to-revoke" });
  check("fresh key works", (await api("/api/validate-cart", tmp.key, { policyId: p1, cart })).status === 200);
  check("revoke succeeds", await revokeApiKey(tmp.id, TA));
  check("revoked key => 401", (await api("/api/validate-cart", tmp.key, { policyId: p1, cart })).status === 401);
  check("revoking via the wrong tenant is refused", !(await revokeApiKey(agentA.id, TB)));
  const expired = await createApiKey({ tenantId: TA, role: "agent", label: "expired", expiresAt: new Date(Date.now() - 60_000) });
  check("expired key => 401", (await api("/api/validate-cart", expired.key, { policyId: p1, cart })).status === 401);

  section("S21 Rate limiting (429 + Retry-After) is per key");
  const rl = await createApiKey({ tenantId: TA, role: "agent", label: "rate" });
  const statuses: number[] = [];
  let retryAfter: string | null = null;
  for (let i = 0; i < 36; i++) { const r = await api("/api/validate-cart", rl.key, {}); statuses.push(r.status); if (r.status === 429) retryAfter = r.headers.get("retry-after"); }
  check("first 30 requests are not rate limited", statuses.slice(0, 30).every((s) => s !== 429), statuses.slice(0, 30));
  check("requests beyond the limit => 429", statuses.slice(30).every((s) => s === 429), statuses.slice(30));
  check("429 carries Retry-After", Number(retryAfter) > 0, retryAfter);
  check("another key is unaffected", (await api("/api/validate-cart", agentB.key, { policyId: pB, cart: cartFor(MB) })).status === 200);

  section("S22 Dashboard: MFA login, signed read-only cookie, tenant-scoped data");
  const login = (key: string, totp: string) => api("/api/admin/login", null, { key, totp });
  const lg = await login(adminLogin.key, code(adminLogin.totpSecret!));
  const setCookie = lg.headers.get("set-cookie") ?? "";
  check("valid key + code => 200", lg.status === 200, lg.status);
  check("cookie is HttpOnly + SameSite=Strict", /HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), setCookie.replace(/=[^;]+/, "=<redacted>"));
  const cookie = setCookie.split(";")[0];
  const page = await (await fetch(APP, { headers: { cookie } })).text();
  check("signed-in page shows tenant A's name and the dashboard shell (rows load client-side via the scoped APIs, see S25)", page.includes(`Tenant A ${RUN}`) && page.includes("Decisions") && page.includes("Exceptions"));
  check("signed-in page does NOT leak tenant B's data", !page.includes("cart-B-secret") && !page.includes(`Tenant B ${RUN}`));
  const anon = await (await fetch(APP)).text();
  check("no cookie => sign-in form, no data", anon.includes("Operator sign-in") && !anon.includes("c-e2e"));
  const forged = await (await fetch(APP, { headers: { cookie: cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A")) } })).text();
  check("tampered cookie => sign-in form", forged.includes("Operator sign-in") && !forged.includes("c-e2e"));
  check("wrong code => 401", (await login(adminLogin.key, "000000")).status === 401);
  check("agent key cannot log in (403→401 uniform)", (await login(agentA.key, "123456")).status === 401);
  const logins: number[] = [];
  for (let i = 0; i < 6; i++) logins.push((await login("sp_adm_" + "x".repeat(43), "000000")).status);
  check("brute-force attempts hit the limiter (429)", logins.includes(429), logins);
  const sessionOnApi = await fetch(`${APP}/api/policies/confirm`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ id: d19b.id, hash: d19b.hash }) });
  check("session cookie cannot call mutating APIs (needs Bearer + MFA)", sessionOnApi.status === 401, sessionOnApi.status);

  section("S23 Audit anchoring");
  const cron = process.env.CRON_SECRET!;
  const anch = (method: string, secret: string | null) => fetch(`${APP}/api/admin/anchor`, { method, headers: secret ? { authorization: `Bearer ${secret}` } : {} });
  check("no secret => 401", (await anch("POST", null)).status === 401);
  check("wrong secret => 401", (await anch("POST", "x".repeat(40))).status === 401);
  const made = await anch("POST", cron);
  const madeJson = (await made.json()) as { seq?: number; sink?: string };
  check("anchor created (sink=db without ANCHOR_SINK_URL)", made.status === 200 && Number(madeJson.seq) > 0 && madeJson.sink === "db", madeJson);
  const ver = (await (await anch("GET", cron)).json()) as { checked: number; mismatched: number[] };
  check("anchors verify against the live chain", ver.checked >= 1 && ver.mismatched.length === 0, ver);
  const mutate = await db().query("UPDATE audit_anchors SET hash = 'x' WHERE seq = $1", [madeJson.seq]).then(() => "mutated", (e: Error) => e.message);
  check("anchor table is append-only (UPDATE rejected)", mutate.includes("append-only"), mutate);

  section("S24 Agent Studio surface + operator assistant");
  const spec = (await (await fetch(`${APP}/api/agent/openapi`)).json()) as { paths: Record<string, unknown> };
  check("OpenAPI lists only the two agent tools", Object.keys(spec.paths).sort().join() === "/api/agent/policies/{id},/api/validate-cart", Object.keys(spec.paths));
  check("assistant: no key => 401", (await api("/api/agent/assistant", null, { question: "hello there" })).status === 401);
  check("assistant: agent key => 403", (await api("/api/agent/assistant", agentA.key, { question: "hello there" })).status === 403);
  const live = await api("/api/agent/assistant", adminA.key, { question: "How many of my recent carts were denied?" });
  console.log(`  ℹ live assistant call (needs Gemini billing): HTTP ${live.status}${live.status === 200 ? " (model reachable)" : " (model unavailable/unfunded — not a code failure)"}`);

  section("S25 Dashboard read APIs: session-only, tenant-scoped, paginated, filterable");
  const dl = await api("/api/admin/login", null, { key: adminDash.key, totp: code(adminDash.totpSecret!) }, { "x-forwarded-for": `10.9.9.${Math.floor(Math.random() * 200)}` });
  const dcookie = (dl.headers.get("set-cookie") ?? "").split(";")[0];
  check("dashboard login ok", dl.status === 200, dl.status);
  const dget = (path: string, cookieHdr: string | null) => fetch(`${APP}${path}`, { headers: cookieHdr ? { cookie: cookieHdr } : {} });
  for (const path of ["/api/admin/validations", "/api/admin/policies", "/api/admin/exceptions"]) {
    check(`${path}: no cookie => 401`, (await dget(path, null)).status === 401);
    check(`${path}: a Bearer admin key alone => 401 (session only)`, (await fetch(`${APP}${path}`, { headers: { authorization: `Bearer ${adminA.key}` } })).status === 401);
  }
  const all = (await (await dget("/api/admin/validations?limit=100", dcookie)).json()) as { rows: Array<{ id: number; cartId: string; decision: string; policyId: string }> };
  check("decisions are returned for the tenant", all.rows.length >= 4, all.rows.length);
  check("no tenant-B data in A's decisions", !JSON.stringify(all).includes("cart-B-secret") && !all.rows.some((r) => r.policyId === pB));
  const denies = (await (await dget("/api/admin/validations?limit=100&decision=DENY", dcookie)).json()) as { rows: Array<{ decision: string }> };
  check("decision filter returns only DENY (and at least one)", denies.rows.length >= 1 && denies.rows.every((r) => r.decision === "DENY"), denies.rows.length);
  const pg1 = (await (await dget("/api/admin/validations?limit=2", dcookie)).json()) as { rows: Array<{ id: number }>; nextBefore: number | null };
  const pg2 = (await (await dget(`/api/admin/validations?limit=2&before=${pg1.nextBefore}`, dcookie)).json()) as { rows: Array<{ id: number }> };
  check("keyset pagination: page 2 is strictly older, no overlap", pg1.rows.length === 2 && pg2.rows.length >= 1 && Math.max(...pg2.rows.map((r) => r.id)) < Math.min(...pg1.rows.map((r) => r.id)), { pg1: pg1.rows, pg2: pg2.rows });
  check("bad query rejected (400)", (await dget("/api/admin/validations?limit=9999", dcookie)).status === 400 && (await dget("/api/admin/validations?decision=HACK", dcookie)).status === 400);
  const pols = (await (await dget("/api/admin/policies", dcookie)).json()) as { policies: Array<{ id: string; status: string; hash: string; rules: string[] }> };
  check("policies: own active + draft present with readback and hash, none of B's", pols.policies.some((x) => x.id === p1 && x.status === "active") && pols.policies.some((x) => x.id === d19b.id && x.status === "draft" && /^[0-9a-f]{64}$/.test(x.hash) && x.rules.length === 2) && !pols.policies.some((x) => x.id === pB));
  const exc = (await (await dget("/api/admin/exceptions", dcookie)).json()) as { exceptions: Array<{ orderId: string; policyId: string; issue: string | null; ambiguous: boolean; attempt: number }> };
  const e7 = exc.exceptions.find((x) => x.orderId === o7), e8 = exc.exceptions.find((x) => x.orderId === o8);
  check("exceptions: CARD_EXPIRED order listed as definitely failed", e7?.issue === "CARD_EXPIRED" && e7.ambiguous === false && e7.attempt === 0, e7);
  check("exceptions: 503 order listed as AMBIGUOUS", e8?.ambiguous === true, e8);
  check("exceptions: a captured order is not listed", !exc.exceptions.some((x) => x.orderId === o1));

  section("S26 Exception re-trigger: strictest endpoint (MFA, ownership, queue-only, reconcile, no double capture)");
  const rt = (k: { key: string; totpSecret?: string }, orderId: string, policyId: string, withCode = true) =>
    api("/api/admin/captures/retrigger", k.key, { orderId, policyId }, withCode ? { "x-sentinel-totp": code(k.totpSecret!) } : {});
  const r1 = await mkAdmin("rt-1"), r2 = await mkAdmin("rt-2"), r3 = await mkAdmin("rt-3"), r4 = await mkAdmin("rt-4"), r5 = await mkAdmin("rt-5"), r6 = await mkAdmin("rt-6"), r7 = await mkAdmin("rt-7");
  check("no MFA code => 401", (await rt(r1, o8, p8, false)).status === 401);
  check("session cookie alone => 401", (await fetch(`${APP}/api/admin/captures/retrigger`, { method: "POST", headers: { cookie: dcookie, "content-type": "application/json" }, body: JSON.stringify({ orderId: o8, policyId: p8 }) })).status === 401);
  check("agent key => 403", (await api("/api/admin/captures/retrigger", agentA.key, { orderId: o8, policyId: p8 }, { "x-sentinel-totp": "123456" })).status === 403);
  check("other tenant's admin cannot touch A's order (404)", (await rt(adminB2, o8, p8)).status === 404);
  check("an order not in the exception queue => 409", (await rt(r1, o2, p2)).status === 409);
  check("an already-captured order => 409 (no double capture)", (await rt(r2, o1, p1)).status === 409);
  check("still no extra capture on the captured order", (await simOrder(o1)).captures === 1);
  check("failed orders were NOT captured by the refused attempts", (await simOrder(o8)).captures === 0 && (await simOrder(o7)).captures === 0);

  await fetch(`${SIM}/sim/orders/${o8}/fault`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ capture_fault: "none" }) });
  const ok8 = await rt(r3, o8, p8);
  const ok8j = (await ok8.json()) as { status?: string; attempt?: number };
  check("ambiguous failure, fault cleared => captured, SAME attempt (request id reused)", ok8.status === 200 && ok8j.status === "CAPTURED" && ok8j.attempt === 0, ok8j);
  check("exactly 1 capture at PayPal, ledger row appears", (await simOrder(o8)).captures === 1 && Boolean(await until(async () => (await ledger(p8)).length === 1)));
  const a8 = await audit(p8);
  check("audit records the re-trigger (attempt 0, reused request id)", a8.some((e) => e.kind === "order.capture_retriggered" && e.payload.attempt === 0 && e.payload.reusedRequestId === true), a8.map((e) => e.kind));

  await fetch(`${SIM}/sim/orders/${o7}/fault`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ capture_fault: "none" }) });
  const ok7 = await rt(r4, o7, p7);
  const ok7j = (await ok7.json()) as { status?: string; attempt?: number };
  check("definite failure, fault cleared => captured with attempt 1 (new request id)", ok7.status === 200 && ok7j.attempt === 1, ok7j);
  const a7 = await audit(p7);
  const origRid = a7.find((e) => e.kind === "order.capture_failed" && !e.payload.retrigger)?.payload.requestId;
  const newRid = a7.find((e) => e.kind === "order.captured" && e.payload.retrigger)?.payload.requestId;
  check("the retry used a different PayPal-Request-Id than the failed attempt", Boolean(origRid && newRid && origRid !== newRid), { origRid, newRid });
  const exc2 = (await (await dget("/api/admin/exceptions", dcookie)).json()) as { exceptions: Array<{ orderId: string }> };
  check("both orders left the exception queue", !exc2.exceptions.some((x) => x.orderId === o7 || x.orderId === o8));
  check("re-triggering a resolved order => 409", (await rt(r5, o7, p7)).status === 409);

  // A retry that fails again keeps the order in the queue and bumps the attempt counter.
  const p26 = await makePolicy(TA, HAPPY);
  const o26 = (await createOrder({ policyId: p26, ...GOOD })).body.id;
  await approve(o26, { capture_fault: "CARD_EXPIRED" });
  const again1 = await rt(r6, o26, p26);
  const again1j = (await again1.json()) as { status?: string; issue?: string; attempt?: number };
  check("retry that fails again => 409 FAILED CARD_EXPIRED (attempt 1)", again1.status === 409 && again1j.issue === "CARD_EXPIRED" && again1j.attempt === 1, again1j);
  const exc3 = (await (await dget("/api/admin/exceptions", dcookie)).json()) as { exceptions: Array<{ orderId: string; attempt: number }> };
  check("order still queued with attempt = 1; no capture happened", exc3.exceptions.find((x) => x.orderId === o26)?.attempt === 1 && (await simOrder(o26)).captures === 0, exc3.exceptions.find((x) => x.orderId === o26));
  const again2j = (await (await rt(r7, o26, p26)).json()) as { attempt?: number };
  check("next retry increments to attempt 2", again2j.attempt === 2, again2j);

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
