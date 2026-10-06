import { z } from "zod";

/**
 * SentinelPay Policy Language v1.
 *
 * Design rules:
 *  - All money is INTEGER MINOR UNITS (cents). No floats anywhere in the engine.
 *  - Rules are a closed discriminated union. Unknown rule kinds fail parsing (fail-closed).
 *  - A policy is a flat, ordered list of independent rules; ALL must pass (logical AND).
 *    A rule list (not a single "AST") is deliberate: each rule is separately
 *    explainable in plain language for the human confirmation step.
 */

export const Minor = z.number().int().nonnegative();
export const Currency = z.string().regex(/^[A-Z]{3}$/);

export const Rule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("max_total"), amount: Minor }),
  z.object({ kind: z.literal("max_tax_shipping"), amount: Minor }),
  z.object({
    kind: z.literal("max_item_price"),
    amount: Minor,
    sku: z.string().min(1).optional(), // omitted = applies to every line
  }),
  z.object({
    kind: z.literal("max_quantity"),
    quantity: z.number().int().positive(),
    sku: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("merchant_allowlist"),
    merchantIds: z.array(z.string().min(1)).min(1),
  }),
  z.object({
    kind: z.literal("price_drift"),
    // Allowed increase of the live price over the baseline, in basis points
    // (100 bps = 1%). 0 = no drift tolerated. Baseline = catalog feed price,
    // optionally stale-bounded: a baseline older than maxBaselineAgeSec is
    // treated as UNKNOWN (=> deny), never as "matches".
    toleranceBps: z.number().int().min(0).max(10_000),
    maxBaselineAgeSec: z.number().int().positive().default(86_400),
  }),
  z.object({
    kind: z.literal("valid_window"),
    notBefore: z.iso.datetime().optional(),
    notAfter: z.iso.datetime().optional(),
  }),
  z.object({
    kind: z.literal("cumulative_budget"),
    amount: Minor,
    windowDays: z.number().int().positive(),
  }),
]);
export type Rule = z.infer<typeof Rule>;

export const Policy = z.object({
  version: z.literal(1),
  currency: Currency,
  rules: z.array(Rule).min(1).max(50),
});
export type Policy = z.infer<typeof Policy>;

export const PolicyStatus = z.enum(["draft", "active", "revoked"]);

/* ---------- Cart snapshot the evaluator reasons over ---------- */

export const CartLine = z.object({
  sku: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPrice: Minor,
  /** Baseline price from Store Sync feed; null/absent => unknown. */
  baselineUnitPrice: Minor.nullable().optional(),
  baselineFetchedAt: z.iso.datetime().nullable().optional(),
});
export type CartLine = z.infer<typeof CartLine>;

export const Cart = z.object({
  cartId: z.string().min(1),
  merchantId: z.string().min(1),
  currency: Currency,
  lines: z.array(CartLine).min(1),
  tax: Minor,
  shipping: Minor,
  /** Total the payment rail will actually charge. Must reconcile with lines. */
  total: Minor,
});
export type Cart = z.infer<typeof Cart>;

export type Decision = "ALLOW" | "DENY" | "REQUIRE_REAUTH";

export interface Violation {
  rule: Rule["kind"] | "integrity";
  code: string;
  message: string;
}

export interface Evaluation {
  decision: Decision;
  violations: Violation[];
}
