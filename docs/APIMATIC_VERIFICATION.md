# APIMatic Context Plugin: verification report (2026-10-20)

**Purpose:** use APIMatic's PayPal Context Plugin as a development-time second opinion on our PayPal integration, which until now was verified only against a simulator *I* wrote from PayPal's docs.
**Outcome:** it found **two real defects** (fixed, with a negative control) and **one open threat it let us close (T21)**, and it is honest about what it **cannot** verify. No call has been made to the real PayPal sandbox; everything below is *documentation-level* evidence.

## 1. What the plugin actually is (corrected from my first assumption)
| Fact | Evidence |
|---|---|
| The Claude Code "paypal" plugin (v0.4.1) is **skills only** (`SKILL.md` markdown for .NET / Python / TypeScript). **No MCP server, hooks, commands, agents or scripts.** | `plugins/paypal/.claude-plugin/plugin.json` (only a `skills` array); file tree of `plugins/paypal`; commit `97bda162cba34576d8633b910fb4f37167812bf8` of `context-plugins/plugin-marketplace` (a mirror of `apimatic/plugin-marketplace`, owner APIMatic). |
| The skills are mostly **API-agnostic usage guides** for APIMatic-generated SDKs. The PayPal *contract facts* live in the generated SDK's own **"SDK map"** (`sdk-map.md`, `map/operations/*.md`, `src/models/*.ts`) in `context-plugins/paypal-typescript-sdk`, commit `5d0df8a8817e5fdf2e2cd48e68f790ea4730aab2`, package name `paypal` v2.29.0 (MIT). | `typescript-integrate-paypal` skill ("lookup layer + contract sheet"). |
| That SDK covers **5 PayPal APIs only**: Orders v2, Payments v2, Vault v3, Transaction Search v1, Subscriptions v1. **Not** webhooks, **not** agentic commerce / Store Sync. | SDK `package.json` description. |
| It is **not** PayPal's official SDK (`@paypal/paypal-server-sdk`); it is an unofficial APIMatic-generated artefact built from PayPal's OpenAPI. Treated here as a *secondary* source and cross-checked against PayPal's own reference. | repo owner `context-plugins`, 0 stars. |

## 2. Install audit (done before running anything) and what I did
- `npx context-plugins install paypal` runs the `context-plugins@0.12.0` CLI (MIT, repo `apimatic/context-plugins-installer`, **no install scripts, zero runtime dependencies**). Source read: it executes only `claude plugin marketplace add|update|remove` / `claude plugin install|uninstall --scope user` (and Codex equivalents), writes `~/.context-plugins/` state (+ VS Code `settings.json` with a backup), contacts GitHub (to fetch the plugin) and Mixpanel (**anonymous telemetry, opt-out**: `DO_NOT_TRACK=1` or `CP_TELEMETRY=off`).
- Plugin content was scanned for unsafe agent instructions (no `curl | sh`, `rm -rf`, "ignore previous instructions", exfiltration).
- **I did not install it into any assistant.** The `claude` CLI is not on the PATH of my environment, and the installer targets Claude Code through that CLI. Because the plugin is plain markdown, I did not need it installed to use it: I fetched the files at the pinned commits and used them as reference data.
- **To install on your own machine (Claude Code only, no telemetry, pinned):**
  ```bash
  DO_NOT_TRACK=1 npx context-plugins install paypal --targets claude --ref 97bda162cba34576d8633b910fb4f37167812bf8
  ```
  (user scope; then `/reload-plugins` in Claude Code.) The skills are only useful for code that uses the PayPal SDK; SentinelPay calls the REST API directly.
- **Installed (2026-10-21), project-local:** the `claude` CLI is not installed on the owner's machine, so the official installer could not run. The 9 TypeScript skills (`plugins/paypal/skills/typescript/*`, MIT licence) were copied from the pinned commit `97bda16…` into `.claude/skills/paypal-typescript-*/` (git-ignored; re-create with the loop in this section's history or the command above). They load automatically in Claude Code sessions for this project. Not the official `claude plugin install` path.

## 3. Verification table
Verdicts: **MATCH** (code agrees) · **MISMATCH** (code disagreed; fixed) · **UNVERIFIED** (this toolchain cannot confirm it) · **N/A**.

| # | Contract fact | Source(s) | Our code | Verdict |
|---|---|---|---|---|
| 1 | Create-order body: `purchase_units[].{reference_id, payee.merchant_id, custom_id, invoice_id, items[].{name, quantity (string), sku, unit_amount}, amount.{currency_code, value, breakdown}}`; `custom_id` 1-255 chars; `invoice_id` 1-127, unique per merchant by default; `quantity` is a whole-number **string** | SDK models + PayPal Orders v2 create reference | `orderToCart`, simulator, e2e helper | **MATCH** |
| 2 | `PayPal-Request-Id` header exists on create and capture (1-10,000 chars) | SDK map + PayPal reference | `requestId()`, `captureOrder` | **MATCH** |
| 3 | `PayPal-Request-Id` **retention window** | A search summary of PayPal docs said 6 h; PayPal's capture reference page **does not state it** | design reconciles with PayPal (GET order must be `APPROVED`) before any re-trigger, so it does not depend on the window | **UNVERIFIED** (no dependency) |
| 4 | **Capture `Prefer` header defaults to `return=minimal`**: reply is only `{id, status, links}`; the full order (with `purchase_units[].payments.captures[]`) needs `Prefer: return=representation` | SDK map (`prefer` default `"return=minimal"`) **and** PayPal's capture reference | `captureOrder` required the nested capture and sent no `Prefer` | **MISMATCH -> fixed** (F1) |
| 5 | Capture `status` enum: COMPLETED, DECLINED, PARTIALLY_REFUNDED, PENDING, REFUNDED, FAILED; **an order can be COMPLETED while its capture is DECLINED/PENDING** | SDK `CaptureStatus` / `OrderStatus` docs | we require `captures[0].status === "COMPLETED"` | **MATCH** |
| 6 | Order status enum: CREATED, SAVED, APPROVED, VOIDED, COMPLETED, PAYER_ACTION_REQUIRED; intent CAPTURE / AUTHORIZE | SDK enums | retrigger proceeds only on `APPROVED`; anything else is "not capturable" | **MATCH** |
| 7 | Error body: `name, message, debug_id, details[{field, value, issue, location, description}]`; HTTP arms: capture 400/401/403/404/422/500, create 400/401/422, get 401/404 | SDK `Error` / operation map | `details[0].issue` read; unknown issue or status => HALT; 5xx => ambiguous | **MATCH** |
| 8 | **Amount equation**: `amount = item_total + tax_total + shipping + handling + insurance - shipping_discount - discount` | PayPal create reference + SDK `AmountBreakdown` | cart reconciliation ignored handling/insurance/discounts | **MISMATCH -> fixed** (F3) |
| 9 | Capture resource carries `custom_id`, `invoice_id` and `supplementary_data.related_ids.order_id` | SDK `PaymentsCapture` / `CapturedPayment` / `PaymentSupplementaryData` / `RelatedIdentifiers` | spend was attributed by `custom_id` only | **GAP -> closed T21** (F2) |
| 10 | Error `issue` **strings** (`DUPLICATE_INVOICE_ID`, `ORDER_ALREADY_CAPTURED`, `CARD_EXPIRED`, …) | SDK models `issue: string` (not enumerated); PayPal "Orders v2 errors" page **not retrieved** | `src/lib/paypal/errors.ts` | **UNVERIFIED** (`invoice_id` uniqueness-by-default makes `DUPLICATE_INVOICE_ID` plausible) |
| 11 | Webhook event types, resource shapes, signature verification scheme | not in this SDK | `src/lib/paypal/webhook.ts` | **N/A: not covered** |
| 12 | OAuth2 client-credentials auth; token endpoint path; currency exponents | SDK says `oauth2`; paths/exponents not in the map | `client.ts`, `toMinor` | **UNVERIFIED** |
| 13 | Agentic Commerce (`merchant-cart`, `ValidationIssue`), Store Sync, Agent Ready | not in this SDK | `errors.ts` (verified earlier from PayPal's public ValidationIssue definition) | **N/A: not covered** |

## 4. Findings and fixes
- **F1 (high): capture could not read a real PayPal success.** Real PayPal replies `{id,status,links}` unless `Prefer: return=representation` is sent. Our code demanded the nested capture and would have reported a successful capture as **FAILED / ambiguous**, polluting the exception queue and inviting wrong retries. The simulator always returned the full object, so it could never reveal this. **Fix:** `captureOrder` sends `Prefer: return=representation`; a minimal body is still treated as ambiguous (never as success); the **simulator now defaults to PayPal's minimal reply**, so the bug cannot hide again.
  **Negative control:** with the header temporarily removed, **8 end-to-end checks fail** (captured orders recorded as `order.capture_failed`, ambiguous, false exceptions, retrigger flow broken); with it, **168/168 pass**.
- **F2 (T21 closed): capture provenance.** `PAYMENT.CAPTURE.COMPLETED` now writes to `spend_ledger` only if the capture traces to an order SentinelPay authorized (an `order.inspected` ALLOW or a human re-trigger for `related_ids.order_id` under the same policy, or our own recorded capture id). Otherwise it is audited as `capture.unattributed` and **not counted**, so a validly signed event for someone else's order cannot burn a cumulative budget. (Fails closed: a missing related id only counts if our own capture id vouches.) e2e S34.
- **F3 (medium): breakdown fidelity.** Carts now carry `handling`, `insurance`, `shippingDiscount`, `discount` and reconcile with PayPal's equation, so a legitimate coupon or fee is no longer falsely DENIED; fees count toward the tax+shipping cap, **discounts never loosen it**; mixed currencies in a breakdown are refused. Unit tests + e2e S35.
- **Design note (from #3):** after an ambiguous failure we reuse the same `PayPal-Request-Id` *and* reconcile first. Even if the key had expired, PayPal refuses a second capture of the same order.

## 5. Limits (read before relying on this)
- Evidence is **documentation-level**. No PayPal sandbox call has been made (O5 stays open for webhook signatures, error issue strings, OAuth path).
- The plugin/SDK map is an **unofficial, beta, vendor-generated** source; every item acted on was cross-checked against PayPal's own reference. Vendor performance claims (e.g. 63% faster implementation) were not verified.
- It does not cover webhooks or the agentic-commerce APIs, which are SentinelPay's core domain.

## 6. Reproduce
1. Fetch `plugins/paypal/**` at `97bda16…` and `sdk-map.md`, `map/operations/orders.md`, `src/models/*.ts` at `5d0df8a…` (GitHub API, read-only).
2. Compare against `src/lib/paypal/*` using the table above.
3. `npm test && npm run e2e:sim` (168 checks). To see the negative control: remove the `prefer:` line in `src/lib/paypal/capture.ts` and re-run.

## 7. AI tools used (for the Devpost submission)
APIMatic Context Plugin content (skills + SDK map) as a development reference for PayPal API contracts (see sections 1-2 for exact scope); Anthropic Claude (runtime policy compiler and operator assistant; also the coding assistant used to build this project).
