# SentinelPay

**A deterministic guardrail between AI shopping agents and PayPal.** You state spending limits in plain language, Claude drafts a strict machine-checked policy, you confirm it with a one-time code, and before any payment an agent calls SentinelPay, which answers `ALLOW`, `REQUIRE_REAUTH` or `DENY` from deterministic code, never from a model.

Built for the [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/). Licensed under [Apache-2.0](LICENSE).

> ⚠️ **Sandbox-stage, not production-ready.** Never run against live PayPal credentials (the PayPal client refuses live hosts unless `PAYPAL_ALLOW_LIVE=1`). See [`docs/STATUS_REPORT.md`](docs/STATUS_REPORT.md).

| | |
|---|---|
| Hosted demo | https://sentinelpay-jiwhxjcfia-ul.a.run.app (Google Cloud Run; `GET /api/health`) |
| Demo video | _[YouTube link: added at submission]_ |
| Tests | 47 unit tests, 134 end-to-end checks, CI on every push |

## Where PayPal and AI are used
- **PayPal:** Orders v2 (create / get / capture with `PayPal-Request-Id` idempotency), webhook signature verification (certificate chain, `crc32`, RSA-SHA256), webhook de-duplication, and PayPal error-enum handling. Capture is attempted **only** after the policy returns `ALLOW`, and an ambiguous failure is never blindly retried.
- **AI (Anthropic Claude):**
  1. **Policy compiler**: natural language → Policy v1 JSON via structured output, then re-validated with strict Zod. It has no tools, and its output is untrusted by design.
  2. **Operator assistant**: a tool-use loop with read-only and dry-run tools only. It explains decisions and refuses to activate policies or move money.
  3. **Agent tool**: an OpenAPI spec (`GET /api/agent/openapi`) lets an external agent (e.g. Google Agent Studio) call the guardrail before paying.
- **Honest status:** the PayPal flow is verified against a local simulator written from PayPal's public docs ([`docs/PAYPAL_SIMULATOR.md`](docs/PAYPAL_SIMULATOR.md)). Verification against PayPal's real sandbox is tracked in [`docs/REMINDERS.md`](docs/REMINDERS.md). Pointing `PAYPAL_BASE_URL` at the sandbox and re-running `npm run e2e:sim` is the contract test.

## How it works
1. **Compile**: an admin posts a directive to `POST /api/policies/compile`. Claude proposes a policy. It is stored as a **draft** with a deterministic plain-language readback and a SHA-256 hash.
2. **Confirm**: a human calls `POST /api/policies/confirm`, echoing the hash with a one-time TOTP code. Only then is the policy `active`, and its body is DB-immutable.
3. **Validate**: the agent calls `POST /api/validate-cart` (`agent` key). A pure, fail-closed evaluator returns `ALLOW | REQUIRE_REAUTH | DENY`.
4. **Webhooks**: `POST /api/webhooks/paypal` verifies PayPal's signature, de-duplicates events, and re-inspects approved orders before any capture.
5. **Audit**: everything is appended to a **hash-chained, append-only log**, anchored hourly to external storage.
6. **Kill-switch**: `POST /api/policies/revoke` (admin + TOTP); the next validation is denied immediately.

Dashboard (session-gated, tenant-scoped): **Decisions**, **Policies** (readback, hash, confirm/revoke), **Exceptions** (failed captures; safe re-trigger that cannot double-capture).

## For judges: try it

### Option A: hosted demo (fastest)
The hosted demo is login-gated and tenant-scoped. **Test credentials (a throwaway demo tenant: key, authenticator secret and URL) are in the "Testing instructions" field of the Devpost submission.** They are not committed to this public repo.

1. Open the hosted URL and sign in with the demo **admin key** and a 6-digit code. Add the demo authenticator secret to any TOTP app (Google Authenticator, Apple Passwords, 1Password, …).
2. **Policies** tab: view the pre-activated demo policy and its readback.
3. Use the **agent key** to call the guardrail (replace `<AGENT_KEY>`, `<POLICY_ID>`, `<MERCHANT_ID>` with the values from the testing instructions):
   ```bash
   curl -s -X POST https://sentinelpay-jiwhxjcfia-ul.a.run.app/api/validate-cart \
     -H "Authorization: Bearer <AGENT_KEY>" -H "Content-Type: application/json" \
     -d '{"policyId":"<POLICY_ID>","cart":{"cartId":"demo-1","merchantId":"<MERCHANT_ID>","currency":"USD",
          "lines":[{"sku":"LAPTOP","quantity":1,"unitPrice":99900}],"tax":8000,"shipping":2000,"total":109900}}'
   ```
   Money is **integer cents**. A cart over a limit returns `REQUIRE_REAUTH` (or `DENY` for integrity problems such as a price mismatch) with reason codes.
4. Compile your own rule (draft only, nothing is activated): `POST /api/policies/compile` with the admin key and `{"directive":"laptop under $1,200, tax + shipping under $150, never more than 2 units"}`. The response shows the plain-language readback.

### Option B: run it yourself (about 10 minutes, no PayPal account needed)
**Requirements:** Node.js 24+, a free [Neon](https://neon.tech) Postgres database (pooled connection string), and an [Anthropic API key](https://console.anthropic.com/) (only for compile / assistant; everything else works without it).

```bash
git clone https://github.com/Mammajam/SentinelPay.git && cd SentinelPay
npm install
cp .env.example .env.local
```
Edit `.env.local`:
- `DATABASE_URL`: your Neon pooled URL (use a throwaway database; the audit log is append-only, so test rows are permanent).
- `ANTHROPIC_API_KEY`: your key (optional model override: `ANTHROPIC_MODEL`, default `claude-sonnet-5-5`).
- `SENTINEL_MASTER_KEY` (`openssl rand -base64 32`), `SESSION_SECRET`, `CRON_SECRET` (`openssl rand -hex 32` each). `ANCHOR_*` settings are only needed for external audit anchoring and can stay empty.

Then:
```bash
npm run db:migrate            # create tables, triggers
npm test                      # 47 unit tests, no database needed
npm run e2e:sim               # 134 end-to-end checks: boots a local PayPal simulator + the app against your DB
```
`npm run e2e:sim` is the quickest proof that everything works: forged, stale and replayed webhooks, over-limit carts, double-capture attempts, ambiguous 5xx, tenant isolation, MFA replay, and audit-chain integrity. It needs no PayPal credentials.

To explore by hand:
```bash
npm run admin -- tenant --id demo --name "Demo" --merchant DEMO_MERCHANT
npm run admin -- key --tenant demo --role admin --label judge   # prints key + TOTP secret ONCE
npm run admin -- key --tenant demo --role agent --label judge   # agent key for validate-cart
npm run dev                                                      # http://localhost:3000
```
Sign in at http://localhost:3000 with the admin key and a TOTP code. Compile a policy via the API (see above, with `http://localhost:3000`), confirm it (`POST /api/policies/confirm` with `{"id","hash"}` and header `x-sentinel-totp: <code>`), then call `validate-cart`.

### Real PayPal sandbox
Set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID` from a developer.paypal.com sandbox app, keep `PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com`, and point the sandbox webhook at `<your URL>/api/webhooks/paypal`.

## Auth model
Tenants own policies and PayPal merchants. Keys are tenant-scoped, hashed, revocable and expiring: `agent` (validate / read) and `admin` (manage). Policy confirmation and dashboard login also need a one-time TOTP code. Rate limits are Postgres-backed. Details: [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md), [`docs/AGENT_STUDIO.md`](docs/AGENT_STUDIO.md).

## Layout
```
src/lib/policy/    rule language (schema), evaluator (pure, fail-closed), readback + hash
src/lib/paypal/    webhook verification, error mitigations, idempotency, Orders v2 -> cart
src/lib/agent/     Claude policy compiler + operator assistant
src/lib/db/        Neon pool, store, hash-chained audit append
src/lib/audit/     chain primitives (pure)
src/app/           Next.js App Router: API routes + operator dashboard
db/schema.sql      tables + immutability / append-only triggers
tools/paypal-sim/  local PayPal simulator
tests/             unit tests; scripts/e2e-sim.ts end-to-end runner
deploy/            Cloud Run deployment (see deploy/README.md)
docs/              status, threat model, compliance scoping, open tasks
```
Note: this Next.js version has `cacheComponents` enabled. Route segment `runtime`/`dynamic` exports are rejected; use `connection()` + `<Suspense>` for per-request data.

## More
[`docs/STATUS_REPORT.md`](docs/STATUS_REPORT.md) · [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) · [`docs/SPEC_ADDENDUM.md`](docs/SPEC_ADDENDUM.md) · [`docs/COMPLIANCE_SCOPING.md`](docs/COMPLIANCE_SCOPING.md) · [`docs/REMINDERS.md`](docs/REMINDERS.md) · [`SECURITY.md`](SECURITY.md)
