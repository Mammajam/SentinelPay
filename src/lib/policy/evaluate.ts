import {
  Cart,
  Policy,
  type Evaluation,
  type Violation,
  type Cart as CartT,
  type Policy as PolicyT,
} from "./schema.ts";

export interface EvalContext {
  now: Date;
  /** Sum of already-settled spend (minor units) per window, supplied by the ledger. */
  spentInWindow: (windowDays: number) => number;
}

/**
 * Deterministic, pure, fail-closed evaluation.
 * - Any parse failure, unknown shape, currency mismatch, or arithmetic
 *   inconsistency => DENY. There is no code path that defaults to ALLOW.
 * - REQUIRE_REAUTH is reserved for limits the *user* can lift by explicitly
 *   re-authorizing (amount ceilings); integrity problems are always DENY.
 */
export function evaluate(
  policyInput: unknown,
  cartInput: unknown,
  ctx: EvalContext,
): Evaluation {
  const p = Policy.safeParse(policyInput);
  if (!p.success) return deny("integrity", "POLICY_INVALID", "Policy failed validation");
  const c = Cart.safeParse(cartInput);
  if (!c.success) return deny("integrity", "CART_INVALID", "Cart failed validation");
  return run(p.data, c.data, ctx);
}

function deny(rule: Violation["rule"], code: string, message: string): Evaluation {
  return { decision: "DENY", violations: [{ rule, code, message }] };
}

function run(policy: PolicyT, cart: CartT, ctx: EvalContext): Evaluation {
  const hard: Violation[] = [];
  const soft: Violation[] = []; // user-liftable ceilings

  if (cart.currency !== policy.currency) {
    hard.push(v("integrity", "CURRENCY_MISMATCH", `Cart is ${cart.currency}, policy is ${policy.currency}`));
  }

  // Reconcile arithmetic: never trust a total the agent/merchant asserts.
  const subtotal = cart.lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  if (subtotal + cart.tax + cart.shipping !== cart.total) {
    hard.push(v("integrity", "TOTAL_DOES_NOT_RECONCILE", "total != lines + tax + shipping"));
  }

  for (const rule of policy.rules) {
    switch (rule.kind) {
      case "max_total":
        if (cart.total > rule.amount) soft.push(v(rule.kind, "TOTAL_EXCEEDED", `Total ${cart.total} > ${rule.amount}`));
        break;
      case "max_tax_shipping":
        if (cart.tax + cart.shipping > rule.amount)
          soft.push(v(rule.kind, "TAX_SHIPPING_EXCEEDED", `Tax+shipping ${cart.tax + cart.shipping} > ${rule.amount}`));
        break;
      case "max_item_price":
        for (const l of cart.lines)
          if ((!rule.sku || rule.sku === l.sku) && l.unitPrice > rule.amount)
            soft.push(v(rule.kind, "ITEM_PRICE_EXCEEDED", `${l.sku} unit price ${l.unitPrice} > ${rule.amount}`));
        break;
      case "max_quantity":
        for (const l of cart.lines)
          if ((!rule.sku || rule.sku === l.sku) && l.quantity > rule.quantity)
            hard.push(v(rule.kind, "QUANTITY_EXCEEDED", `${l.sku} qty ${l.quantity} > ${rule.quantity}`));
        break;
      case "merchant_allowlist":
        if (!rule.merchantIds.includes(cart.merchantId))
          hard.push(v(rule.kind, "MERCHANT_NOT_ALLOWED", `Merchant ${cart.merchantId} not allowlisted`));
        break;
      case "price_drift":
        for (const l of cart.lines) {
          const b = l.baselineUnitPrice;
          const fetched = l.baselineFetchedAt ? Date.parse(l.baselineFetchedAt) : NaN;
          const fresh = !Number.isNaN(fetched) && ctx.now.getTime() - fetched <= rule.maxBaselineAgeSec * 1000;
          if (b == null || !fresh) {
            // Unknown baseline is NOT "no drift".
            hard.push(v(rule.kind, "BASELINE_UNKNOWN", `${l.sku}: baseline missing or stale`));
          } else if (l.unitPrice * 10_000 > b * (10_000 + rule.toleranceBps)) {
            soft.push(v(rule.kind, "PRICE_DRIFT", `${l.sku}: ${l.unitPrice} vs baseline ${b} (> ${rule.toleranceBps} bps)`));
          }
        }
        break;
      case "valid_window": {
        const t = ctx.now.getTime();
        if (rule.notBefore && t < Date.parse(rule.notBefore)) hard.push(v(rule.kind, "NOT_YET_VALID", "Policy not yet valid"));
        if (rule.notAfter && t > Date.parse(rule.notAfter)) hard.push(v(rule.kind, "EXPIRED", "Policy expired"));
        break;
      }
      case "cumulative_budget": {
        const spent = ctx.spentInWindow(rule.windowDays);
        if (!Number.isFinite(spent) || spent < 0) hard.push(v(rule.kind, "LEDGER_UNAVAILABLE", "Spend ledger unreadable"));
        else if (spent + cart.total > rule.amount)
          soft.push(v(rule.kind, "BUDGET_EXCEEDED", `Spent ${spent} + ${cart.total} > ${rule.amount} / ${rule.windowDays}d`));
        break;
      }
      default: {
        const _exhaustive: never = rule;
        hard.push(v("integrity", "UNKNOWN_RULE", String(_exhaustive)));
      }
    }
  }

  if (hard.length) return { decision: "DENY", violations: [...hard, ...soft] };
  if (soft.length) return { decision: "REQUIRE_REAUTH", violations: soft };
  return { decision: "ALLOW", violations: [] };
}

const v = (rule: Violation["rule"], code: string, message: string): Violation => ({ rule, code, message });
