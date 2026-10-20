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
 * CSV / spreadsheet-formula injection defence. Cart ids, SKUs and merchant strings are controlled by
 * AGENTS (untrusted input); a cell starting with = + - @ (or a tab/CR) would execute as a formula when
 * the exported file is opened in Excel/Sheets. Prefix such STRINGS with a single quote. Numbers pass through.
 */
export function csvSafe(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v !== "string") return String(v);
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}
