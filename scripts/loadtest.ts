// Load test for POST /api/validate-cart (target: p95 < 150 ms).
//   npm run loadtest -- <base-url> [totalRequests=300] [concurrency=10]
// e.g. npm run loadtest -- https://sentinelpay-xxxx-ue.a.run.app 300 10
// Creates a throwaway tenant + policy + agent keys directly in the database (rows are permanent:
// the audit log is append-only), then drives the HTTP API. Client-side latency includes the network
// path from where you run it; compare with server-side latencyMs in the logs (docs: deploy/README.md).
import { randomUUID } from "node:crypto";
import { Policy } from "../src/lib/policy/schema.ts";
import { policyHash } from "../src/lib/policy/readback.ts";
import { activatePolicy, createTenant, insertDraftPolicy, registerMerchant } from "../src/lib/db/store.ts";
import { createApiKey } from "../src/lib/auth/keys.ts";
import { db } from "../src/lib/db/client.ts";

const [base = "", totalArg = "300", concArg = "10"] = process.argv.slice(2);
if (!/^https?:\/\//.test(base)) { console.error("usage: npm run loadtest -- <base-url> [total] [concurrency]"); process.exit(2); }
const TOTAL = Number(totalArg), CONC = Number(concArg), WARMUP = Math.min(10, Math.floor(TOTAL / 10));
const PER_KEY = 400; // stay under the default 600/min per-key limit

const run = randomUUID().slice(0, 6);
const tenant = `lt-${run}`, merchant = `LTM-${run}`;
await createTenant(tenant, `Load test ${run}`);
await registerMerchant(tenant, merchant);
const compiled = Policy.parse({ version: 1, currency: "USD", rules: [{ kind: "max_total", amount: 120_000 }, { kind: "max_tax_shipping", amount: 15_000 }] });
const hash = policyHash(compiled);
const policyId = await insertDraftPolicy({ ownerId: tenant, sourceText: "load test", compiled, hash, compiler: "loadtest" });
await activatePolicy(policyId, hash, "loadtest", tenant);
const keys = await Promise.all(Array.from({ length: Math.ceil(TOTAL / PER_KEY) }, () => createApiKey({ tenantId: tenant, role: "agent", label: "loadtest" })));
await db().end();

const cart = (i: number) => ({ cartId: `lt-${run}-${i}`, merchantId: merchant, currency: "USD", lines: [{ sku: "LAP1", quantity: 1, unitPrice: 100_000 }], tax: 8_000, shipping: 2_000, total: 110_000 });
const lat: number[] = [];
let ok = 0, errs = 0, limited = 0;
const codes = new Map<number, number>();
let next = 0;

async function worker() {
  while (true) {
    const i = next++;
    if (i >= TOTAL) return;
    const t0 = performance.now();
    try {
      const r = await fetch(`${base}/api/validate-cart`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${keys[Math.floor(i / PER_KEY)].key}` },
        body: JSON.stringify({ policyId, cart: cart(i) }),
      });
      const j = (await r.json()) as { decision?: string };
      const ms = performance.now() - t0;
      codes.set(r.status, (codes.get(r.status) ?? 0) + 1);
      if (r.status === 429) limited++;
      else if (r.status === 200 && j.decision === "ALLOW") { ok++; if (i >= WARMUP) lat.push(ms); } else errs++;
    } catch { errs++; }
  }
}

const start = performance.now();
await Promise.all(Array.from({ length: CONC }, worker));
const secs = (performance.now() - start) / 1000;
lat.sort((a, b) => a - b);
const q = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))].toFixed(0) : "n/a");
console.log(`\n${base}  total=${TOTAL} concurrency=${CONC} warmup-excluded=${WARMUP}`);
console.log(`ALLOW ok=${ok}  errors=${errs}  rate-limited=${limited}  statuses=${JSON.stringify(Object.fromEntries(codes))}`);
console.log(`throughput ${(TOTAL / secs).toFixed(1)} req/s over ${secs.toFixed(1)} s`);
console.log(`latency ms  p50=${q(0.5)}  p90=${q(0.9)}  p95=${q(0.95)}  p99=${q(0.99)}  max=${lat.length ? lat[lat.length - 1].toFixed(0) : "n/a"}`);
console.log(`target p95 < 150 ms: ${lat.length && Number(q(0.95)) < 150 ? "MET" : "NOT MET"} (client-side, includes network from here)`);
process.exit(errs || limited ? 1 : 0);
