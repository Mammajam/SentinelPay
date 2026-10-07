import { createHash } from "node:crypto";
import type { Policy, Rule } from "./schema.ts";

const money = (minor: number, cur: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(minor / 100);

/**
 * Plain-language readback generated DETERMINISTICALLY from the compiled policy
 * (never by an LLM). This is what the human confirms, so what they read is
 * exactly what will be enforced.
 */
export function readback(policy: Policy): string[] {
  const c = policy.currency;
  return policy.rules.map((r: Rule) => {
    switch (r.kind) {
      case "max_total": return `Total charge must not exceed ${money(r.amount, c)}.`;
      case "max_tax_shipping": return `Tax + shipping combined must not exceed ${money(r.amount, c)}.`;
      case "max_item_price": return `${r.sku ? `Item ${r.sku}` : "Any item"} must not cost more than ${money(r.amount, c)} each.`;
      case "max_quantity": return `${r.sku ? `Item ${r.sku}` : "Any item"}: at most ${r.quantity} unit(s).`;
      case "merchant_allowlist": return `Only these merchants are allowed: ${r.merchantIds.join(", ")}.`;
      case "price_drift":
        return r.toleranceBps === 0
          ? `No price increase over the catalog price is allowed (catalog data older than ${r.maxBaselineAgeSec}s is treated as unknown and blocks the purchase).`
          : `Price may exceed the catalog price by at most ${(r.toleranceBps / 100).toFixed(2)}%.`;
      case "valid_window": return `Valid ${r.notBefore ? `from ${r.notBefore} ` : ""}${r.notAfter ? `until ${r.notAfter}` : ""}`.trim() + ".";
      case "cumulative_budget": return `Total spend across all purchases must not exceed ${money(r.amount, c)} per ${r.windowDays} day(s).`;
    }
  });
}

/** Canonical JSON (sorted keys) so the hash is stable. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    // Skip undefined like JSON.stringify does, so the canonical form of an object equals
    // the canonical form of its JSON/DB round-trip (otherwise `{a: undefined}` hashes as "undefined").
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const policyHash = (p: Policy) => createHash("sha256").update(canonicalize(p)).digest("hex");
