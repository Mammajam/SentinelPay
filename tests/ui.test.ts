import { test } from "node:test";
import assert from "node:assert/strict";
import { csvSafe, isHotRow, mergeById, RED_CODES } from "../src/lib/ui/rows.ts";

test("isHotRow: price/integrity violations are hot; ordinary limit breaches and empty are not", () => {
  for (const code of RED_CODES) assert.equal(isHotRow([{ code }]), true, code);
  assert.equal(isHotRow([{ code: "TOTAL_EXCEEDED" }, { code: "PRICE_DRIFT" }]), true, "any hot code makes the row hot");
  assert.equal(isHotRow([{ code: "TOTAL_EXCEEDED" }]), false);
  assert.equal(isHotRow([]), false);
  assert.equal(isHotRow(undefined), false);
});

test("mergeById: de-duplicates (later wins) and sorts newest first", () => {
  const out = mergeById([{ id: 1, v: "a" }, { id: 3, v: "c" }, { id: 2, v: "b" }, { id: 3, v: "c2" }]);
  assert.deepEqual(out.map((r) => r.id), [3, 2, 1]);
  assert.equal(out[0].v, "c2");
  assert.deepEqual(mergeById([]), []);
});

test("csvSafe: neutralises spreadsheet formula injection in agent-controlled strings", () => {
  for (const evil of ["=HYPERLINK(\"http://x\")", "+1+1", "-2+3", "@SUM(A1)", "\t=cmd", "\r=cmd"]) {
    assert.equal(csvSafe(evil), `'${evil}`, JSON.stringify(evil));
  }
  assert.equal(csvSafe("cart-123"), "cart-123");
  assert.equal(csvSafe("a=b"), "a=b", "only a LEADING trigger character matters");
  assert.equal(csvSafe(-5), "-5", "numbers are not strings and pass through");
  assert.equal(csvSafe(null), "");
  assert.equal(csvSafe(undefined), "");
});
