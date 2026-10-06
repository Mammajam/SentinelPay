import { Cart } from "../policy/schema.ts";

const EXPONENT: Record<string, number> = { JPY: 0, KRW: 0, HUF: 0, TWD: 0, BHD: 3, KWD: 3 };

/** "12.34" -> 1234 using string math (no floats). Throws on malformed input. */
export function toMinor(value: string, currency: string): number {
  const exp = EXPONENT[currency] ?? 2;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) throw new Error(`bad amount ${value}`);
  const frac = m[2] ?? "";
  if (frac.length > exp) throw new Error(`too many decimals for ${currency}`);
  return Number(m[1] + frac.padEnd(exp, "0"));
}

interface MoneyV2 { currency_code: string; value: string }
interface OrderResource {
  id: string;
  purchase_units?: Array<{
    custom_id?: string;
    payee?: { merchant_id?: string };
    amount?: { currency_code: string; value: string; breakdown?: { item_total?: MoneyV2; tax_total?: MoneyV2; shipping?: MoneyV2 } };
    items?: Array<{ sku?: string; name: string; quantity: string; unit_amount: MoneyV2 }>;
  }>;
}

/**
 * Orders v2 resource -> Cart snapshot for the evaluator. Convention: the agent
 * sets `purchase_units[0].custom_id` to the SentinelPay policy id. Missing
 * breakdown / items / merchant => throws => caller fails closed.
 * Baseline prices are NOT in the order; they must be joined from Store Sync feed
 * data by the caller (see docs/SPEC_ADDENDUM.md, open item O3).
 */
export function orderToCart(o: OrderResource): { policyId: string; cart: Omit<Cart, "lines"> & { lines: Array<{ sku: string; quantity: number; unitPrice: number }> } } {
  const pu = o.purchase_units?.[0];
  if (!pu?.custom_id || !pu.amount?.breakdown || !pu.items?.length || !pu.payee?.merchant_id) throw new Error("order missing required fields");
  const cur = pu.amount.currency_code;
  const m = (x?: MoneyV2) => (x ? toMinor(x.value, x.currency_code) : 0);
  return {
    policyId: pu.custom_id,
    cart: {
      cartId: o.id,
      merchantId: pu.payee.merchant_id,
      currency: cur,
      lines: pu.items.map((i) => {
        if (!i.sku) throw new Error("item missing sku");
        return { sku: i.sku, quantity: Number(i.quantity), unitPrice: toMinor(i.unit_amount.value, i.unit_amount.currency_code) };
      }),
      tax: m(pu.amount.breakdown.tax_total),
      shipping: m(pu.amount.breakdown.shipping),
      total: toMinor(pu.amount.value, cur),
    },
  };
}
