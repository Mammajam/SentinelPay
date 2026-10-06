/**
 * Deterministic mitigation table. Enum names for `PRICING_ERROR` / `PAYMENT_ERROR`
 * specific issues are taken from PayPal's agentic-commerce ValidationIssue
 * definition (verified 2026-10-06). Orders v2 issues are from Orders v2 docs
 * (see docs/SPEC_ADDENDUM.md for verification status per entry).
 *
 * Unlike the original concept, NO mitigation hands the decision back to the LLM.
 * The proxy returns a structured, machine-actionable result; the agent may
 * only relay it.
 */
export type Action =
  | { type: "HALT"; reason: string }
  | { type: "REQUIRE_REAUTH"; reason: string }
  | { type: "RE_EVALUATE_WITHOUT_DISCOUNT"; reason: string }
  | { type: "LOOKUP_EXISTING_ORDER"; reason: string }
  | { type: "INVALIDATE_TOKEN"; reason: string };

export const MITIGATIONS: Record<string, Action> = {
  // Agentic commerce ValidationIssue (PRICING_ERROR)
  "PRICING_ERROR/PRICE_MISMATCH": { type: "REQUIRE_REAUTH", reason: "Live price differs from baseline; re-run policy on live price" },
  "PRICING_ERROR/DISCOUNT_EXPIRED": { type: "RE_EVALUATE_WITHOUT_DISCOUNT", reason: "Coupon expired; re-price cart and re-run policy (no agent-side coupon hunting)" },
  "PRICING_ERROR/TAX_CALCULATION_FAILED": { type: "HALT", reason: "Incomplete tax: capture blocked" },
  "PRICING_ERROR/CURRENCY_MISMATCH": { type: "HALT", reason: "Currency mismatch" },
  "PRICING_ERROR/CURRENCY_NOT_SUPPORTED": { type: "HALT", reason: "Currency not supported" },
  // Agentic commerce ValidationIssue (PAYMENT_ERROR)
  "PAYMENT_ERROR/PAYMENT_AMOUNT_TOO_LARGE": { type: "REQUIRE_REAUTH", reason: "Exceeds authorized payment limit; explicit user re-authorization required" },
  "PAYMENT_ERROR/PAYMENT_FRAUD_DETECTED": { type: "HALT", reason: "Processor flagged fraud" },
  "PAYMENT_ERROR/PAYMENT_EXPIRED": { type: "INVALIDATE_TOKEN", reason: "Payment credential expired" },
  "PAYMENT_ERROR/PAYMENT_PROCESSOR_UNAVAILABLE": { type: "HALT", reason: "Processor unavailable; do not auto-retry capture" },
  // Orders v2 issues
  "ORDERS_V2/DUPLICATE_INVOICE_ID": { type: "LOOKUP_EXISTING_ORDER", reason: "Never blind-retry: a prior attempt may have succeeded. Look up the order by invoice_id first" },
  "ORDERS_V2/CARD_EXPIRED": { type: "INVALIDATE_TOKEN", reason: "Vaulted card expired" },
};

/** Unknown issue => HALT. Never retry what we do not understand. */
export function mitigationFor(code: string, specificIssue: string): Action {
  return MITIGATIONS[`${code}/${specificIssue}`] ?? { type: "HALT", reason: `Unrecognized issue ${code}/${specificIssue}` };
}
