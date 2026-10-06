# Spec Addendum: Validation of Original Assumptions (2026-10-06)

Checked against PayPal developer docs via web research this session. **Verified** = confirmed in a PayPal page I fetched. **From knowledge** = not re-checked this session. **Unverified** = could not confirm; treat as a risk.

| Original claim | Finding | Status | Action taken |
|---|---|---|---|
| `PricingErrorContext` / `PRICE_MISMATCH`, `DISCOUNT_EXPIRED`, `TAX_CALCULATION_FAILED` | Real. They are `specific_issue` values under the `PRICING_ERROR` code of the Agentic Commerce `ValidationIssue`. Also exist: `DISCOUNT_USAGE_LIMIT_EXCEEDED`, `CURRENCY_MISMATCH`, `PROMOTIONAL_CONFLICT`, etc. | Verified | Mapping table keyed `CODE/SPECIFIC_ISSUE` in `src/lib/paypal/errors.ts` |
| `PaymentErrorContext` / `PAYMENT_AMOUNT_TOO_LARGE` | Real, under `PAYMENT_ERROR`. Also `PAYMENT_EXPIRED`, `PAYMENT_FRAUD_DETECTED`, `PAYMENT_PROCESSOR_UNAVAILABLE`. | Verified | Mapped |
| Cart endpoint `/v1/createcart` | Docs show **`POST /merchant-cart`** (operation "Create cart"). The `/v1/createcart` path in the concept is wrong. | Verified | Not used; no cart-endpoint call is implemented yet |
| ACP: Braintree **delegated payment tokens** (ChatGPT) | Agent Ready docs: customer authorizes PayPal; *"your app receives a delegated token to process transactions through Braintree"* | Verified | |
| UCP: **single-use Google Pay token** (Gemini/AI Mode) via Braintree | Confirmed in docs | Verified | |
| SentinelPay can **intercept** those tokens as a third-party proxy | Docs describe the **merchant** receiving and processing them. Nothing found that provides for a third-party interception point. | **Unverified — major risk** | Architecture changed: v0 is **decision-only** (validate cart/order amounts), never handles tokens. Open item O2 |
| Store Sync catalogs via Google Shopping-style feed, HTTPS/SFTP/S3 | Store Sync is a catalog/inventory/pricing discovery product with routing of orders to fulfillment. Feed-format details not re-checked | Partially verified | Baseline-price join left as open item O3 |
| Webhook verification: headers `PAYPAL-AUTH-ALGO`, `-CERT-URL`, `-TRANSMISSION-ID/-SIG/-TIME`; signed string `id\|time\|webhookId\|crc32(body)` | Matches PayPal's documented manual verification method (the "CRC32" in the concept is an *input to* the RSA signature check, not the check itself) | From knowledge (search blocked this session) | Implemented in full with cert-URL allowlist, raw-body, timestamp window. **Verify against sandbox webhooks before relying on it** |
| `DUPLICATE_INVOICE_ID` => generate new UUID and retry | Unsafe. A prior attempt may have settled. | Design correction | Look up existing order; deterministic `PayPal-Request-Id` |
| `CARD_EXPIRED` as Orders v2 error | Plausible; exact Orders v2 / Vault v3 enum name not re-checked | Unverified | Kept, flagged |
| Orders v2 `intent`, `amount.breakdown.{item_total,tax_total,shipping}` | Standard Orders v2 structure | From knowledge | `orderToCart()` parses it |

## Open items
- **O2** Confirm with PayPal whether any non-merchant party may sit in the token path (ACP/UCP). Until answered, do not design around token interception.
- **O3** Define how Store Sync baseline prices reach the evaluator (feed ingestion job vs. query). Until then `price_drift` policies correctly DENY (`BASELINE_UNKNOWN`).
- **O5** Confirm exact Orders v2 / Vault v3 error enum names in sandbox.
- **O6** "GEAP" interpreted as Google's enterprise agent platform (Vertex/Gemini). If you meant a different product, only `src/lib/agent/geap.ts` changes.

Sources: PayPal ValidationIssue definition (developer.paypal.com/api/agentic-commerce/v1/definitions/validationissue); Agent Ready overview (developer.paypal.com/agent-ready/overview); docs.paypal.ai agentic-commerce pages.
