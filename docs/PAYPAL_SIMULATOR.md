# Local PayPal Simulator

`tools/paypal-sim/server.mjs` is a dependency-free Node server that plays PayPal's role so the capture, ledger and failure paths can be tested without a PayPal developer account. **It is not PayPal.** It encodes my reading of PayPal's published docs; it cannot prove PayPal's real behaviour.

## Run
```bash
npm run sim            # simulator on :4010 (webhooks -> SIM_WEBHOOK_URL, default :3000)
npm run e2e:sim        # boots simulator + app, runs 41 checks against your Neon DB
```
`e2e:sim` writes test rows (owner `e2e`) to the database in `DATABASE_URL`. The audit log is append-only by design, so those rows are permanent; use a dev database.

## What it models
OAuth token · Orders v2 create/get/capture · `PayPal-Request-Id` idempotency · `DUPLICATE_INVOICE_ID`, `AMOUNT_MISMATCH`, `ORDER_ALREADY_CAPTURED`, `CARD_EXPIRED`, 503 · signed webhooks (`id|time|webhookId|crc32(body)`, RSA-SHA256, cert served at `/v1/notifications/certs/CERT-SIM`) · webhook faults: `tamper`, `stale`, `badcert`, `replay`.

## Simulator vs real PayPal sandbox
| | Simulator | Sandbox |
|---|---|---|
| Source of truth | My reading of the docs | PayPal's actual behaviour |
| Signatures | Self-signed, same algorithm | Real PayPal certificates; the only proof the scheme is right |
| Error shapes | From published enums | Real, including surprises |
| Failure injection | Any failure, on demand | Hard to trigger deliberately |
| CI / cost | Offline, free, no secrets | Needs credentials and network |
| ACP/UCP tokens, Agent Ready | Not modelled | May require program enrollment |

## Safety rails
- The verifier trusts only `https://*.paypal.com` cert URLs. The simulator's `http://localhost` origin is allowed **only** when `devCertOrigin()` proves a local dev setup: `NODE_ENV != production`, loopback PayPal base URL, loopback `http` cert origin. Unit-tested in `tests/sim.test.ts`; `next start` (production) can never enable it.
- `src/lib/paypal/client.ts` refuses `api-m.paypal.com` / `api.paypal.com` unless `PAYPAL_ALLOW_LIVE=1`.

## Known gap: buyer/seller accounts are NOT modelled
The simulator has no personal (buyer) or business (seller) accounts. A "seller" is only the `payee.merchant_id` string on an order (bound to a tenant in SentinelPay), and there is no payer identity, funding source, balance, login, or approval screen: approval is a simulator-only call. So it exercises SentinelPay's logic, not the buyer or seller *experience*. Adding it means: payer accounts with funding sources/balances (insufficient funds, expired card), a payer-approval step, merchant accounts with fee/payout and Seller-Protection states, and refunds/disputes. See the answer in the project notes before building.

## Contract-drift mitigation
The scenario runner knows only base URLs. When sandbox access exists, point `PAYPAL_BASE_URL` at the sandbox and re-run the same flow as a contract test. Until then **O5 stays open**: simulator success does not prove real PayPal signatures or error enums.

## Bugs this found (fixed, with regression tests)
1. Audit `seq` concatenated as a string (`"1"+1 → "11"`) because Postgres returns `bigint` as text; writes broke after a few entries.
2. Audit hash included `undefined` fields that the DB drops, so entries with optional fields could never re-verify.
Neither was visible to the original unit tests, which never round-tripped through Postgres.
