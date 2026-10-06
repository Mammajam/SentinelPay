import { createHash } from "node:crypto";

/**
 * Deterministic PayPal-Request-Id. The SAME logical operation always yields the
 * SAME key, so a retry after a timeout is deduplicated by PayPal instead of
 * double-charging. (A random UUID per retry — the original concept — defeats
 * idempotency.) `attempt` only changes when a human/support explicitly
 * re-triggers after confirming the previous attempt did not settle.
 */
export function requestId(parts: { policyId: string; cartId: string; operation: "create" | "capture" | "authorize"; attempt?: number }): string {
  const h = createHash("sha256")
    .update([parts.policyId, parts.cartId, parts.operation, parts.attempt ?? 0].join("|"))
    .digest("hex");
  // Format as UUID-shaped string (8-4-4-4-12) for PayPal's header.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
