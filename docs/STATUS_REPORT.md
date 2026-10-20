# SentinelPay Status Report

> **How to read this file.** It is a dated log. Entries before **2026-10-20** describe the original **Gemini/Vertex AI** implementation and are kept as a historical record: that provider was **replaced by Anthropic Claude on 2026-10-20** (see that entry). The authoritative current state is the "Current state" block below and the final entries. Open tasks live in `docs/REMINDERS.md`.

## Current state (2026-10-20)
- **Live**: Cloud Run `sentinelpay` (us-east5), revision serving 100%, secrets in Secret Manager, hourly GCS audit anchors (291+ verified), `/api/health` + `/api/ready` green.
- **AI provider**: Anthropic Claude (`claude-sonnet-5-5`) for the policy compiler and operator assistant. **Verified live**: correct compilation, prompt-injection resistance (harmless `$0`), previously dropped limits now captured, assistant refuses write requests.
- **Dashboard**: AG Grid Community (Decisions, Exceptions) + policy cards; Live mode, CSV export (formula-injection safe), red violation rows, dark/light theme.
- **Tests**: 50 unit, 134 end-to-end, CI green; `npm audit --omit=dev`: 0 vulnerabilities.
- **Biggest gap**: no call has ever been made to the **real PayPal sandbox** (simulator only). See `docs/DEVPOST_DRAFT.md` and `docs/REMINDERS.md`.

---

_Original report, 2026-10-06 (historical):_

## Summary
The six recommendations from the concept assessment were actioned. A working, tested, type-checked, building Next.js vertical slice exists. **Not production-ready**: nothing has run against a live Neon database, PayPal sandbox, or Gemini/GEAP yet (no credentials in this environment), and capture initiation is not implemented.

## Recommendation scorecard

| # | Recommendation | Status | Evidence |
|---|---|---|---|
| 1 | Validate PayPal / protocol assumptions | **Done (partial)** | `docs/SPEC_ADDENDUM.md`. Error enums verified; `/v1/createcart` found incorrect (`POST /merchant-cart`); token-interception claim **unverified and flagged as major risk**. One webhook-docs search was blocked, so webhook scheme is from prior knowledge and must be confirmed in sandbox. |
| 2 | Threat model + compliance scoping | **Done (docs)** | `docs/THREAT_MODEL.md` (17 threats, status per item), `docs/COMPLIANCE_SCOPING.md` (6 scoping questions). Legal conclusions deliberately not drawn. |
| 3 | Redesign policy schema; human confirmation of compile | **Done** | Closed rule union, 8 rule kinds, integer minor units, bps drift tolerance with staleness bound; deterministic readback + hash-echo confirmation; DB trigger freezes active policies. |
| 4 | Fix idempotency + webhook verification | **Done in code** | Deterministic `PayPal-Request-Id`; duplicate-invoice => lookup; full signature scheme, cert-URL allowlist, raw-body, timestamp window, replay table. Capture call itself **not** implemented. |
| 5 | Thin vertical slice first; AG Grid later | **Done** | Compile → confirm → validate → webhook inspect → audit → read-only dashboard. AG Grid deferred to Phase 4. |
| 6 | Fail-closed, metrics | **Done (fail-closed); metrics not started** | Every error path => DENY/HALT. No latency targets or SLOs defined yet. |

## What was built
- **Scaffold**: Next.js 16.4 (App Router, TS, Tailwind, Turbopack, cacheComponents), `@neondatabase/serverless`, `zod`, `@google/genai`.
- **Policy engine** (`src/lib/policy`): pure evaluator, rules: max_total, max_tax_shipping, max_item_price, max_quantity, merchant_allowlist, price_drift, valid_window, cumulative_budget. Hard violations (integrity, allowlist, stale baseline, expiry) => `DENY`; user-liftable ceilings => `REQUIRE_REAUTH`.
- **GEAP agent** (`src/lib/agent/geap.ts`): `PolicyCompiler` interface; Gemini implementation with structured JSON output, Vertex (GEAP) or API-key mode. Tool-less and untrusted by design.
- **Neon** (`db/schema.sql`, `src/lib/db`): policies, spend_ledger, validations, webhook_events, audit_log; advisory-lock-serialized hash chain; immutability and append-only triggers.
- **API**: `/api/policies/compile`, `/api/policies/confirm`, `/api/validate-cart`, `/api/webhooks/paypal`. Role-separated bearer keys.
- **Dashboard**: read-only validation table + audit-chain integrity indicator.

## Verification performed
| Check | Result |
|---|---|
| Unit tests (`npm test`, 15 cases: policy, fail-closed, webhook signature w/ real RSA keypair, CRC32 vector, cert-URL attacks, idempotency, audit tamper/deletion) | **15/15 pass** |
| `tsc --noEmit` | Clean |
| `next build` | Passes (all 4 API routes + dashboard) |
| Runtime smoke test, no DB/keys | No auth → 401; webhook unconfigured → 503; authed but DB down → **DENY 503** (fail-closed confirmed) |

## NOT verified / not done
- No live run against Neon (schema SQL and `Pool` transaction/advisory-lock path untested), PayPal sandbox, or Gemini/GEAP.
- Webhook verification never exercised with a real PayPal-signed event.
- `max_*`/drift thresholds are correct per unit tests only; no property/fuzz tests.
- **Capture not implemented** (OAuth, `POST /v2/checkout/orders/{id}/capture`), nor `PAYMENT.CAPTURE.COMPLETED` → ledger, `VAULT.PAYMENT-TOKEN.CREATED` binding.
- Store Sync baseline-price ingestion (O3): until built, any policy with `price_drift` DENIES.
- Auth is a placeholder (no IdP/MFA/rate limits); no tenant read isolation (T13).
- Playwright/UI verification not done; dashboard untested against real rows.
- Latency/SLO targets, metrics, pricing and moat questions from the assessment remain open (business, not code).

## Environment issues encountered
- `create-next-app` rejects the folder name "Sentinel Pay" (space/capitals); scaffolded under a valid name and copied in. Package name is `sentinelpay`.
- `npm i -D vitest tsx` failed (peer conflict) and a retry was blocked by the sandbox; replaced with Node 24's built-in test runner (zero added deps).
- A scaffold-created `.git` directory exists in the project; removal was blocked, so it is left as an initialized, empty repo (no commits).
- `AGENTS.md` (generated by Next) says this Next version differs from training data. I consulted the bundled docs for the `cacheComponents` constraints; other APIs used (route handlers, `Response.json`) built and ran successfully.
- "GEAP" interpreted as Google's enterprise agent platform (Vertex/Gemini). Confirm.

## Next steps (priority order)
1. Provide Neon `DATABASE_URL`; run `npm run db:migrate`; integration-test the audit chain under concurrency.
2. Provide a PayPal sandbox app + webhook id; verify real webhook signatures; implement capture with idempotency keys.
3. Get PayPal's answer on O2 (token path) before any adapter work.
4. Add rate limiting, real admin auth with MFA, tenant isolation.
5. Define SLOs (suggest p95 < 150 ms for validate-cart) and metrics.
6. Phase 4: AG Grid dashboard (confirm licensing) with the exception/re-trigger panel.

---
## Update 2026-10-07 — simulator, live Neon, capture path
- **Neon**: schema migrated (5 tables, 2 triggers). Connectivity verified with the rotated credentials.
- **Capture path built**: `src/lib/paypal/{client,capture}.ts`; webhook route now captures only on ALLOW, records `PAYMENT.CAPTURE.COMPLETED` in `spend_ledger`, un-claims events on failure so PayPal retries are processed.
- **Local PayPal simulator** (`docs/PAYPAL_SIMULATOR.md`): 41 end-to-end checks against the real app + real Neon, **41/41 pass** (forged/stale/replayed webhooks, over-limit, double-capture, ambiguous 5xx, concurrency, audit-chain integrity).
- **Two real bugs found and fixed** (audit seq string concat; undefined-in-hash). Dev DB test rows were reset twice with explicit approval.
- **Unit tests**: 25/25. **Dependency audit**: see `docs/DEPENDENCY_AUDIT.md` (production deps clean).
- **Still open**: Gemini generation blocked by depleted AI Studio credits (compiler untested live); PayPal sandbox access (O2/O5); Store Sync baselines (O3); auth/tenant isolation/rate limits; AG Grid (no Enterprise licence — Community/TanStack planned).

---
## Update 2026-10-07 (2) — Phase 4 hardening + agentic surface
- **Auth**: DB-backed, hashed, revocable, expiring, tenant-scoped API keys (`agent`/`admin`); admin TOTP (RFC 6238, verified against the RFC vectors) required for policy confirmation and dashboard login; TOTP seeds sealed with AES-256-GCM (`SENTINEL_MASTER_KEY`); env-based key lists removed. Operator CLI: `npm run admin`.
- **Tenant isolation**: tenant comes from the key (the `ownerId` request field is gone); scoped reads/activation; merchants bound to one tenant and enforced on validate-cart and the webhook path (cross-tenant policy use / budget burning blocked).
- **Rate limiting**: Postgres-backed, fail-closed; per-key, per-tenant (compile hourly + daily quota), per-IP and per-key login.
- **Audit anchoring (O4, partial)**: append-only anchors + optional HMAC-signed external sink; verified against the live chain and shown on the dashboard. Without `ANCHOR_SINK_URL` this does not stop a DB superuser.
- **Dashboard**: session-gated, tenant-scoped, read-only (AG Grid still deferred; no Enterprise licence).
- **Agentic**: operator assistant (Gemini function-calling, read-only/dry-run tools, tenant-bound) and an OpenAPI tool spec for Google Agent Studio (`docs/AGENT_STUDIO.md`).
- **Verification**: unit tests 39/39 (incl. RFC 6238 vectors); e2e 86/86 against real Neon + simulator (tenant isolation, MFA replay, revocation/expiry, rate limits, cookie tamper, anchoring, concurrency, audit chain).
- **Not done**: external IdP/SSO; managed secret store; live Gemini call (credits depleted); real Agent Studio project test; capture-provenance check (T21); AG Grid.

---
## Update 2026-10-07 (3) — Phase 5: operator dashboard
- **Dashboard**: Decisions (filter, keyset pagination, red rows for price/integrity violations), Policies (readback + hash; confirm with key + code), Exceptions (open capture failures + re-trigger). Plain React tables (TanStack Table v9 was evaluated and dropped: new API, no benefit here; AG Grid Enterprise unavailable).
- **New read APIs** (session cookie only, tenant-scoped): `/api/admin/validations|policies|exceptions`. **New money-moving API**: `POST /api/admin/captures/retrigger` (admin key + single-use TOTP, queue-only, PayPal-state reconciliation, fresh policy check, idempotency-key reuse after ambiguous failure).
- **Verified**: unit 39/39; e2e **120/120** (twice in a row); lint, typecheck, build clean. UI checked visually in the browser pane against a throwaway seeded tenant.
- **Found by visual check and fixed**: Next prerender error (`new Date()` before request time), unreadable red rows in dark mode, misleading empty state while loading, scaffold tab title.
- **Found by test**: a flaky replay test (TOTP window rollover) — fixed by reusing the identical code.
- **All open work**: see `docs/REMINDERS.md`.

---
## Update 2026-10-09 — Phase 6a: deployed to Cloud Run, load-tested, optimised
- **Deployed** (`deploy/cloudrun.sh`, `deploy/README.md`): Cloud Run `sentinelpay` in `us-east5` (next to Neon `us-east-2`), secrets in Secret Manager, create-only GCS anchor bucket (30-day retention, **not yet locked**), hourly Cloud Scheduler anchor job, Vertex AI via service account (no API key). Verified live: health/ready, Agent Studio OpenAPI, auth, anchors written to GCS and verified, scheduler enabled.
- **Gemini via Vertex works** (the AI Studio 402 no longer matters). A live bug was found and fixed: Vertex rejects the full Zod JSON Schema ("too many states"); a sanitised schema is sent while strict Zod validation remains the real check (`src/lib/agent/schema.ts`). Live results: laptop directive correct; prompt-injection directive produced a harmless `max_total = $0`; **a "never more than 2 units" limit was silently dropped** by the model (the human readback/confirm step is what catches this; see REMINDERS).
- **Kill-switch**: `POST /api/policies/revoke` (admin + MFA), dashboard button, e2e-tested (validation 403 and capture denied immediately).
- **Operations**: structured JSON logs (redacted), `/api/health` + `/api/ready`, per-stage timing in `cart.validated` logs, CLI `add-merchant|list-keys|rotate`, webhook cert-cache TTL.

### Load test, `POST /api/validate-cart`, Cloud Run vs Neon (server-side p95 target < 150 ms)
| | Before | After (rev 00010) |
|---|---|---|
| Round trips per request | ~10 (auth, rate, policy, merchant, record, audit x5) | 3 (rate, record, group-committed audit) |
| Server-side p50 / p95 / p99 | ~240 / ~325 / n/a serial; ~500 / ~554 under c=10 | **89 / 137 / 196 ms** (980 requests, c=1/10/25) |
| Throughput ceiling | ~14 req/s (global advisory lock held ~72 ms) | 76 req/s at c=25 and still scaling |
| Target p95 < 150 ms | NOT MET | **MET (server-side)** |
Findings: one DB round trip costs ~24 ms (Cloud Run to Neon). The old global lock capped the system; fixes = lock-free **group-commit** audit append (DB-enforced linearity: PK `seq` + UNIQUE `prev_hash`, retry on conflict), and short TTL caches for key auth (10 s), active policies (5 s) and positive merchant bindings (30 s) **on the advisory path only**. Webhook, capture and re-trigger always read fresh; MFA calls never use the auth cache.
**Caveats**: client-side p50 from the owner's location is ~280 ms (network dominates; `/api/health` alone is ~425 ms with a fresh TLS handshake there). Cold starts (min-instances 0) produced a ~4.3 s outlier: set `MIN_INSTANCES=1` for production. Numbers are one policy, one region, warm instances; re-measure with real traffic shape.
- **Verified**: unit 46/46; e2e **134/134** twice (incl. 25-way concurrent audit, cache TTL propagation); CI green.


## Update 2026-10-20: model provider swapped to Anthropic Claude
Policy compiler (`src/lib/agent/compiler.ts`, structured output via `output_config.format` + strict Zod) and operator assistant (`src/lib/agent/assistant.ts`, tool-use loop) now use `@anthropic-ai/sdk`; `@google/genai`, Vertex IAM/API and `schema.ts` were removed. Earlier sections describe the Gemini implementation historically. Not yet verified live (needs `ANTHROPIC_API_KEY`).

---
## Update 2026-10-20 (2) — AG Grid dashboard, live verification of Claude
- **AG Grid Community 36.2.0 (MIT) integrated** (`src/app/data-grid.tsx`, `src/app/dashboard-client.tsx`, pure helpers in `src/lib/ui/rows.ts`): sortable/filterable/paginated grids for Decisions and Exceptions; red rows for price/integrity violations (light + dark); **Live** mode polls every 5 s and merges by id (keeps sort/filter/page); **CSV export** neutralises agent-controlled values that start with `= + - @` (spreadsheet formula injection); the re-trigger action opens a secure key + one-time-code panel under the grid. Policies stay as cards on purpose (the readback must read well). The grid loads client-only (no server render) to avoid a light-theme flash.
- **Verified in a real browser** against a seeded throwaway tenant: sorting/filters/pagination (37 rows, 25 per page), DENY filter, red rows with readable text, **real CSV export captured and checked** (hostile `=HYPERLINK(...)` cart id exported as `'=HYPERLINK(...)`), Live arrival of an externally inserted decision (appeared within one poll, highlighted, page preserved), Exceptions grid with the UNKNOWN-outcome row highlighted and the secure panel.
- **Live Claude verification on production**: laptop directive compiled correctly; injection directive produced `max_total = $0`; phone directive now includes `max_quantity 2` (previously dropped by the Gemini model); assistant refused to activate/capture. Stored drafts record `claude:claude-sonnet-5-5`.
- **Tests**: unit 50/50 (new `tests/ui.test.ts`), e2e 134/134, lint/typecheck/build clean, `npm audit --omit=dev` 0 vulnerabilities.
- **Not done / open**: real PayPal sandbox integration; AG Grid sponsor-prize eligibility (rules not read); demo video and Devpost submission; items in `docs/REMINDERS.md`.
