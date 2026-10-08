# SentinelPay — open tasks & reminders

_Last updated 2026-10-07 (after Phase 5). Tick items off here as they close. "You" = the project owner; "Me" = the coding assistant._

## A. Needs YOU (blocking or time-sensitive)
- [ ] **Confirm you re-rotated the Neon password.** My diagnostic printed the second rotated password in a tool output on 2026-10-07; it should be treated as exposed. (Neon console → Roles → reset `neondb_owner`, then update `DATABASE_URL` in `.env.local`, single `postgresql://` prefix.)
- [ ] **Fund Gemini** (AI Studio credits, or set up Vertex with a real GCP *project ID* in `GEAP_PROJECT`). Until then the policy compiler and operator assistant are untested live (HTTP 402/502). Then I re-run the compiler tests incl. prompt-injection red-teaming.
- [ ] **Create your first admin key** and add the TOTP secret to an authenticator app: `npm run admin -- key --tenant mytenant --role admin --label "my laptop"` (run it yourself; it prints secrets once). Then sign in at the dashboard.
- [ ] **Register your real PayPal merchant id** (tenant `mytenant` currently has the placeholder `YOUR_MERCHANT_ID`).
- [ ] **Send the PayPal inquiry** in `docs/O2_PAYPAL_INQUIRY.md` (token-path question, pre-capture hook, capture-only credentials, webhook verification, Seller Protection, Store Sync). Record the answer in `docs/SPEC_ADDENDUM.md` (closes O2).
- [ ] **Get PayPal sandbox access** (a collaborator's sandbox credentials, a supported-country account/entity, or PayPal's reply on Liberia). Unblocks O5: verify real webhook signatures and error enums.
- [ ] **Decide:** build the simulator's buyer/seller account model? (personal vs business accounts, balances, approval step, fees/payouts, refunds/disputes.)
- [ ] **Re-check https://www.postman.com/paypal when it is reachable** (returned Cloudflare 525 "SSL handshake failed" on 2026-10-08, a Postman-side outage). 10-minute test, see `docs/POSTMAN_ASSESSMENT.md`: (a) is there an Agentic Commerce / Store Sync / `merchant-cart` collection? (b) does *Orders > Create Order* work with Postman's default token and no own credentials? (c) do examples include error responses?
- [ ] **Decide:** evaluate PayPal's Agent Toolkit / MCP server as the "actions" side with SentinelPay as the guardrail (I have not opened that repo, per your instruction).
- [ ] **Deploy to an HTTPS host** (Vercel / Cloud Run), set env vars there, then import `/api/agent/openapi` into Google Agent Studio and test with a real agent. Labels in the console may differ from `docs/AGENT_STUDIO.md`.
- [ ] **Answer the compliance questions** C1–C6 in `docs/COMPLIANCE_SCOPING.md` with counsel/PayPal before any production traffic.
- [ ] (Optional) Confirm Apache-2.0 licence; decide whether AG Grid Community should replace the plain tables (no Enterprise licence).
- [ ] (Info) GitHub's **Agents tab** is Copilot coding agent (paid Copilot plan); nothing in this project depends on it.

## B. Needs ME (engineering backlog, roughly by priority)
### Security / correctness
- [ ] **Revoke-policy API + UI** (`status='revoked'` exists in the schema but nothing sets it).
- [ ] **T21 capture provenance**: `PAYMENT.CAPTURE.COMPLETED` is attributed by `custom_id` only; require the capture to link to an order we authorized (real PayPal payloads carry the order id).
- [ ] **Store Sync baseline ingestion (O3)**: `catalog_prices` table + feed job so `price_drift` stops returning DENY (`BASELINE_UNKNOWN`) for every order.
- [ ] **VAULT.PAYMENT-TOKEN.CREATED** handling (bind token *reference* only; currently logged).
- [ ] Webhook **certificate cache has no TTL** (`src/app/api/webhooks/paypal/route.ts`): add expiry/size bound.
- [ ] **Property/fuzz tests** for the evaluator ("ALLOW ⇒ every rule holds"; never ALLOW on non-reconciling totals).
- [ ] Operator CLI: `add-merchant`, `list-keys`, key **rotation** helper, tenant deletion/retention path (GDPR; audit stores ids/hashes only).
- [ ] Re-trigger flow is e2e-tested at the API; exercise the **UI forms with real MFA** end-to-end.
- [ ] Re-run `npm audit` periodically; dev-only `braces` advisory has no fix yet (`docs/DEPENDENCY_AUDIT.md`).
### Platform / ops (Phase 6)
- [ ] **Deploy** + production env/secret manager (replace plain env vars; `SENTINEL_MASTER_KEY` is the root secret).
- [ ] **External anchor sink** (object-lock bucket + small function) and a **scheduler** hitting `POST /api/admin/anchor` (needs `CRON_SECRET`); without the sink a DB superuser can rewrite chain + anchors.
- [ ] **External IdP/SSO** for operators (OIDC) on top of keys+TOTP.
- [ ] **SLOs + metrics + structured logs**; **load test** `validate-cart` against the p95 < 150 ms target (never measured).
- [ ] **CI e2e** against an ephemeral Neon branch (currently CI runs unit tests only; e2e needs DB secrets).
- [ ] Branch protection: optionally require PR review; keep CI required.
- [ ] **Production cut-over checklist**: C1–C4 answered, pen test, legal review, O1 enforced (SentinelPay is the only capture path), `PAYPAL_ALLOW_LIVE=1` deliberately.
### Product
- [ ] Policy **compile UI** (currently API-only) and a policy diff view.
- [ ] Optional **MCP server** transport for Gemini Enterprise (needs OAuth 2.0 + admin toggle).
- [ ] Optional AG Grid Community swap-in for the tables.
- [ ] Silence the `MODULE_TYPELESS_PACKAGE_JSON` Node warning (`"type": "module"` needs a compatibility check with Next config files).

## C. Known limits (not tasks, but don't forget)
- Simulator ≠ PayPal: success proves our logic against *my reading* of the docs, not PayPal's real contract (O5).
- Audit anchoring without an external sink does not stop a DB superuser.
- Git history: the Phase 4 work landed in one commit labelled "feat(agent)…" (a failed `git add` skipped the first commit). Content is correct; label is imprecise.
- `e2e:sim` writes permanent test rows to the dev database (audit log is append-only by design).
