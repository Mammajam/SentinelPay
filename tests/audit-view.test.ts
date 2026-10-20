import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { boundedPayload, describeAuditEntry, GLOBAL_KINDS, TENANT_KINDS } from "../src/lib/audit/view.ts";
import { openCursor, sealCursor } from "../src/lib/audit/cursor.ts";
import { makeEntry, entryHash } from "../src/lib/audit/chain.ts";
import { clearState, loadState, sanitizeState, saveState, type StorageLike } from "../src/lib/ui/grid-state.ts";
import { formatMinor, mergeByKey } from "../src/lib/ui/rows.ts";

const ENV = { SENTINEL_MASTER_KEY: randomBytes(32).toString("base64") };

test("describeAuditEntry: every tenant-visible kind has a specific summary and never throws on odd payloads", () => {
  const samples: Record<string, unknown> = {
    "policy.drafted": { id: "abcdef12-0000", compiler: "claude:x" }, "policy.activated": { id: "abcdef12-0000" }, "policy.revoked": { id: "abcdef12-0000" },
    "cart.validated": { cartId: "c1", decision: "DENY", violations: [{ code: "PRICE_DRIFT" }] },
    "order.inspected": { orderId: "O1", decision: "ALLOW" }, "order.captured": { orderId: "O1" },
    "order.capture_failed": { orderId: "O1", issue: "CARD_EXPIRED", ambiguous: false }, "order.capture_retriggered": { orderId: "O1", attempt: 2 },
    "order.retrigger_refused": { orderId: "O1", reason: "policy" }, "capture.recorded": { captureId: "CAP-123456789012345", amount: 110000 },
    "capture.unattributed": {}, "admin.login": { keyId: "k1234567890" }, "assistant.query": { toolsUsed: ["list_recent_decisions"] },
  };
  for (const k of TENANT_KINDS) {
    const d = describeAuditEntry(k, samples[k]);
    assert.ok(d.summary.length > 5 && d.summary !== k, `${k}: ${d.summary}`);
    for (const weird of [null, undefined, 42, "str", [], { violations: "x" }]) assert.doesNotThrow(() => describeAuditEntry(k, weird), `${k} with ${JSON.stringify(weird)}`);
  }
  assert.equal(describeAuditEntry("cart.validated", samples["cart.validated"]).tone, "bad");
  assert.match(describeAuditEntry("cart.validated", samples["cart.validated"]).summary, /PRICE_DRIFT/);
  assert.equal(describeAuditEntry("policy.revoked", { id: "x" }).tone, "bad");
  assert.match(describeAuditEntry("capture.recorded", { captureId: "CAP-1", amount: 110000 }).summary, /1100\.00/);
  assert.equal(describeAuditEntry("future.kind", {}).summary, "future.kind");
});

test("tenant-visible and global audit kinds never overlap (global/unauthenticated events stay out of tenant views)", () => {
  for (const g of GLOBAL_KINDS) assert.equal((TENANT_KINDS as readonly string[]).includes(g), false, g);
});

test("boundedPayload truncates large payloads and survives circular data", () => {
  assert.ok(boundedPayload({ a: "x".repeat(10_000) }, 500).length < 600);
  assert.match(boundedPayload({ a: "x".repeat(10_000) }, 500), /truncated/);
  const circ: Record<string, unknown> = {}; circ.self = circ;
  assert.equal(boundedPayload(circ), "(unserialisable)");
});

test("audit cursor: opaque, round-trips, bound to the tenant, and rejects tampering", () => {
  const c = sealCursor(4242, "acme", ENV);
  assert.ok(!c.includes("4242"), "the seq must not be visible in the token");
  assert.equal(openCursor(c, "acme", ENV), 4242);
  assert.equal(openCursor(c, "other-tenant", ENV), null, "a cursor from tenant A is useless to tenant B");
  const [v, iv, tag, ct] = c.split(".");
  assert.equal(openCursor([v, iv, tag, ct.slice(0, -2) + "AA"].join("."), "acme", ENV), null, "tampered");
  for (const bad of ["", "garbage", "v1.a.b.c", "4242"]) assert.equal(openCursor(bad, "acme", ENV), null, JSON.stringify(bad));
  assert.equal(openCursor(c, "acme", { SENTINEL_MASTER_KEY: randomBytes(32).toString("base64") }), null, "different master key");
  assert.equal(openCursor(sealCursor(4242, "acme", ENV), "acme", {}), null, "missing key fails closed (null, not a crash)");
});

test("selfHashOk logic: an entry re-hashes to itself; any alteration is detected", () => {
  const e = makeEntry(null, "cart.validated", { cartId: "c1", decision: "ALLOW" });
  const roundTripped = JSON.parse(JSON.stringify(e.payload));
  assert.equal(entryHash(e.prevHash, e.kind, roundTripped, e.at), e.hash);
  assert.notEqual(entryHash(e.prevHash, e.kind, { cartId: "c1", decision: "DENY" }, e.at), e.hash);
  assert.notEqual(entryHash(e.prevHash, "order.captured", roundTripped, e.at), e.hash);
});

class MemStorage implements StorageLike {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
}

test("grid layout persistence: round-trip, sanitising, and every failure mode degrades to 'no saved layout'", () => {
  const st = new MemStorage();
  const state = [{ colId: "id", width: 90, sort: "desc" as const, sortIndex: 0 }, { colId: "cart", hide: true }];
  assert.equal(saveState("decisions", state, st), true);
  assert.deepEqual(loadState("decisions", st), state);
  assert.equal(loadState("other", st), null);
  clearState("decisions", st);
  assert.equal(loadState("decisions", st), null);

  // junk and unexpected fields are dropped, hostile shapes rejected
  assert.deepEqual(sanitizeState([{ colId: "a", width: -5, evil: "<script>", sort: "sideways" }]), [{ colId: "a" }]);
  for (const bad of [null, "x", {}, [], [1], [{ colId: 5 }], Array.from({ length: 100 }, (_, i) => ({ colId: `c${i}` })), [{ colId: "x".repeat(500) }]]) assert.equal(sanitizeState(bad), null, JSON.stringify(bad).slice(0, 40));

  st.setItem("sentinelpay:grid:corrupt", "{not json");
  assert.equal(loadState("corrupt", st), null, "corrupt JSON ignored");
  st.setItem("sentinelpay:grid:huge", JSON.stringify([{ colId: "a" }]) + " ".repeat(20_000));
  assert.equal(loadState("huge", st), null, "oversized value ignored");

  const throwing: StorageLike = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("quota"); }, removeItem() { throw new Error("blocked"); } };
  assert.equal(loadState("x", throwing), null);
  assert.equal(saveState("x", state, throwing), false);
  assert.doesNotThrow(() => clearState("x", throwing));
  assert.equal(loadState("x", undefined), null);
  assert.equal(saveState("x", state, undefined), false);
});

test("mergeByKey de-duplicates (later wins) and orders; formatMinor formats cents", () => {
  const rows = [{ h: "a", t: 1 }, { h: "b", t: 3 }, { h: "a", t: 2 }, { h: "c", t: 0 }];
  const out = mergeByKey(rows, (r) => r.h, (x, y) => y.t - x.t);
  assert.deepEqual(out.map((r) => r.h), ["b", "a", "c"]);
  assert.equal(out.find((r) => r.h === "a")?.t, 2);
  assert.equal(formatMinor(110000, "USD"), "$1,100.00");
  assert.equal(formatMinor(5, "USD"), "$0.05");
  assert.match(formatMinor(1250, "not-a-code"), /12\.50 not-a-code/);
});
