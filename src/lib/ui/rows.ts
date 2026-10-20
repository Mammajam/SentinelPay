/**
 * Pure helpers behind the dashboard grids (kept out of the React file so they are unit-tested).
 */

/** Violation codes an operator must look at: price surprises and integrity failures get a red row. */
export const RED_CODES = new Set([
  "PRICE_DRIFT",
  "BASELINE_UNKNOWN",
  "TOTAL_DOES_NOT_RECONCILE",
  "MERCHANT_NOT_REGISTERED",
  "MERCHANT_NOT_ALLOWED",
  "CURRENCY_MISMATCH",
]);

export const isHotRow = (violations: ReadonlyArray<{ code: string }> | undefined): boolean =>
  (violations ?? []).some((v) => RED_CODES.has(v.code));

/** De-duplicate by numeric `id` (later entries win) and sort newest-first. Used when live polling merges pages. */
export function mergeById<T extends { id: number }>(rows: ReadonlyArray<T>): T[] {
  const byId = new Map<number, T>();
  for (const r of rows) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => b.id - a.id);
}

/**
 * Generic merge for live polling: de-duplicate by `key` (later entries win) and order with `compare`.
 * Rows are identified by a stable key (e.g. a hash) so a poll can never duplicate or reorder existing rows.
 */
export function mergeByKey<T>(rows: ReadonlyArray<T>, key: (r: T) => string | number, compare: (a: T, b: T) => number): T[] {
  const byKey = new Map<string | number, T>();
  for (const r of rows) byKey.set(key(r), r);
  return [...byKey.values()].sort(compare);
}

/** Format integer minor units as currency, e.g. (110000, "USD") => "$1,100.00". Falls back to "<n> <CUR>" for unknown codes. */
export function formatMinor(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * CSV / spreadsheet-formula injection defence. Cart ids, SKUs and merchant strings are controlled by
 * AGENTS (untrusted input); a cell starting with = + - @ (or a tab/CR) would execute as a formula when
 * the exported file is opened in Excel/Sheets. Prefix such STRINGS with a single quote. Numbers pass through.
 */
export function csvSafe(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v !== "string") return String(v);
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** Audit rows that must stand out: an entry that no longer hashes to itself (tamper), a failed capture, or a revoked policy. */
export const isHotAudit = (r: { selfHashOk: boolean; kind: string }): boolean =>
  !r.selfHashOk || r.kind === "order.capture_failed" || r.kind === "policy.revoked";
