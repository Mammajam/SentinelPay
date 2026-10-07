# SentinelPay

> ⚠️ **Sandbox-stage, not production-ready.** Never run against live PayPal credentials. See `docs/STATUS_REPORT.md`.

Deterministic guardrail & verification proxy for agentic commerce on PayPal. Next.js 16 · Neon Postgres · GEAP/Gemini policy-compiler agent.

> Status: **sandbox-stage vertical slice.** Read `docs/STATUS_REPORT.md` first, then `docs/SPEC_ADDENDUM.md`, `docs/THREAT_MODEL.md`, `docs/COMPLIANCE_SCOPING.md`.

## How it works
1. **Compile** — an admin submits a natural-language directive to `POST /api/policies/compile`. A GEAP/Gemini agent (no tools, untrusted output) proposes a Policy v1 JSON. It is stored as a **draft** with a deterministic plain-language readback and a SHA-256 hash.
2. **Confirm** — a human calls `POST /api/policies/confirm` echoing the hash. Only then is the policy `active`; its body is then DB-immutable.
3. **Validate** — the agent calls `POST /api/validate-cart` (`agent` key). A pure, fail-closed evaluator returns `ALLOW | REQUIRE_REAUTH | DENY`.
4. **Webhooks** — `POST /api/webhooks/paypal` verifies PayPal's signature, de-duplicates events, and inspects approved orders before any capture (capture call is a Phase 2 TODO).
5. Everything is appended to a **hash-chained, append-only audit log**.

## Auth model (Phase 4)
Tenants own policies and PayPal merchants. Keys are tenant-scoped, hashed, revocable, expiring: `agent` (validate/read) and `admin` (manage). Policy confirmation and dashboard login need a one-time TOTP code. Dashboard sessions are read-only signed cookies. Rate limits are Postgres-backed. Audit-chain heads are anchored periodically. Details: `docs/THREAT_MODEL.md`, `docs/AGENT_STUDIO.md`.

## Setup
```bash
npm install
cp .env.example .env.local     # fill DATABASE_URL, GEAP_*/GOOGLE_API_KEY, key digests
npm run db:migrate             # applies db/schema.sql to Neon
npm test                       # 39 unit tests (node:test, no extra deps)
npm run admin -- tenant --id acme --name "Acme" --merchant MERCHANT_ID
npm run admin -- key --tenant acme --role admin   # prints key + TOTP secret once
npm run e2e:sim                # 86 end-to-end checks (simulator + real app + Neon)
npm run dev
```
Keys are created with `npm run admin` (no key lists in env). Generate `SENTINEL_MASTER_KEY`, `SESSION_SECRET`, `CRON_SECRET` as described in `.env.example`.

## Layout
```
src/lib/policy/    schema (rule language), evaluate (pure, fail-closed), readback (+hash)
src/lib/paypal/    webhook verification, error mitigations, idempotency, Orders v2 -> cart
src/lib/agent/     GEAP/Gemini policy compiler (PolicyCompiler interface)
src/lib/db/        Neon pool, store, hash-chained audit append
src/lib/audit/     chain primitives (pure)
db/schema.sql      tables + immutability/append-only triggers
tests/core.test.ts
```
Note: this Next.js version has `cacheComponents` enabled — route segment `runtime`/`dynamic` exports are rejected; use `connection()` + `<Suspense>` for per-request data.
