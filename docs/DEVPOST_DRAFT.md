# PayPal AI Hackathon 2026 — SentinelPay submission kit

**Event:** "Build What's Next with PayPal and AI" · submit at https://paypalaihackathon.devpost.com/ · submissions close **Nov 12, 2026** (time zone not stated on PayPal's blog; **verify on the Devpost page** and submit at least 48 h early). Winners announced Dec 21, 2026.
**Stated rule:** the project "must meaningfully use both PayPal and AI." The announcement does not list required APIs, sandbox use, judging criteria or submission contents; **read the Devpost Rules/Overview tabs** before relying on anything below.
**Target prizes:** Best Use of Agentic Commerce ($5k), Best Use of PayPal + AI ($5k), Best Demo Delivery ($5k), Best Overall; sponsor bonuses (e.g. AG Grid) have their own rules, check them.

## Honest readiness vs. "meaningfully use PayPal and AI"
| Area | State | Gap |
|---|---|---|
| **AI** | **Strong.** Gemini (Vertex AI) compiles natural-language spending rules into validated policies; an operator assistant answers questions with read-only/dry-run tools and refuses to move money; an OpenAPI tool lets an external agent (Google Agent Studio) call the guardrail. Verified live on Cloud Run. | Agent Studio import not tested in a real Agent Studio project. |
| **PayPal** | **Weak spot.** Implements Orders v2 capture with idempotency, webhook signature verification, agentic-commerce error handling, merchant binding. Verified against a **local simulator I wrote from PayPal's docs**, not against PayPal. | **No call has been made to the real PayPal sandbox** (no sandbox account). Judges will likely expect a real sandbox integration. **Highest-priority gap.** |
| Product & engineering | Strong: deployed, 134-check e2e suite, threat model, audit chain with external anchors, p95 137 ms. | Demo video, screenshots, polished README front page. |

## What remains before submitting (priority order)
1. **Get real PayPal sandbox access** (blocking for credibility). Ask the hackathon organisers/Discord/Devpost Q&A (the event is open "from around the world") and PayPal developer support how to get sandbox credentials from Liberia, or use a teammate's sandbox app. Then: real create-order → approve → webhook → capture through SentinelPay, record it on video, run the e2e scenario runner against the sandbox base URL, and verify webhook signatures with real PayPal certs (closes O5).
2. **Pin down the Devpost rules** (required fields, video length/hosting, repo/open-source requirement, testing instructions, eligibility, deadline time zone, sponsor-prize conditions).
3. **Demo video** (≤3 min is typical; confirm): script below. Hosted public (YouTube/Vimeo).
4. **Devpost text, images, "Built with", links** (draft below), architecture diagram, 3-5 screenshots (dashboard red rows, policy readback, exception queue, assistant answer, anchor in GCS).
5. **Judge access**: a test tenant + admin key + authenticator secret, or a recorded walkthrough, since the dashboard is login-gated. Do NOT put real secrets in the Devpost text; use a throwaway demo tenant.
6. Operational hygiene before the public window: lock the anchor bucket, separate the prod database from dev/e2e data, `MIN_INSTANCES=1`, re-run `npm test` + `npm run e2e:sim`, confirm CI green on `main`, README up to date.
7. Optional prize levers: AG Grid sponsor prize (replace the plain tables with AG Grid Community if the sponsor rules allow); compiler completeness fix (a stated limit was dropped in one live test).

## Demo video outline (~3 min)
1. (0:00) Problem: agents can overspend/hallucinate/be prompt-injected at checkout; LLMs are non-deterministic.
2. (0:20) Say a rule in plain English → Gemini drafts a policy → deterministic readback → human confirms with MFA.
3. (0:50) Agent calls `validateCart` (ALLOW / REQUIRE_REAUTH / DENY); show a prompt-injection directive compiling to a harmless limit.
4. (1:30) **Real PayPal sandbox** order → approve → signed webhook → inspect → capture only on ALLOW (needs step 1). Show an over-limit order that is NOT captured.
5. (2:05) Kill-switch: revoke the policy; the next order is denied. Exception queue: re-trigger a failed capture safely (no double charge).
6. (2:30) Operator assistant: tool-grounded answers; it refuses to activate/capture. Tamper-evident audit chain + external anchors.
7. (2:50) Architecture + what's next.

## Devpost text (draft: replace [PENDING] items once true)
**Tagline:** A deterministic guardrail between AI shopping agents and PayPal, so agents can spend for you without ever spending more than you said.

**Inspiration.** AI agents are starting to buy things for us, but LLMs hallucinate, get prompt-injected, and see prices change mid-checkout. A payment needs a checker that does not guess.

**What it does.** You describe limits in plain language ("laptop under $1,200, tax + shipping under $150"). Gemini turns that into a strict, machine-checked policy; SentinelPay reads it back in plain English and activates it only after you confirm with a one-time code. Before any payment, an agent calls SentinelPay, which returns ALLOW / REQUIRE_REAUTH / DENY from deterministic code, never from a model. PayPal webhooks are signature-verified, orders are re-inspected, and capture happens only on ALLOW, with idempotency keys so a retry cannot double-charge. Everything lands in a hash-chained audit log anchored hourly to immutable cloud storage. An operator assistant explains decisions using read-only tools and cannot change policy or move money.

**How we built it.** Next.js 16 on Google Cloud Run; Neon Postgres; Gemini via Vertex AI (structured output, strict Zod validation of every model answer); PayPal Orders v2 + webhooks [PENDING: real sandbox]; OpenAPI tool for Google Agent Studio agents; Secret Manager, Cloud Scheduler, GCS.

**Challenges.** Models drop or invent constraints, so every model output is untrusted and the human reads back exactly what will be enforced. Cutting p95 latency from ~325 ms to 137 ms by removing a global audit lock (group commit) and caching only on the advisory path. Making retries safe when a capture's outcome is unknown.

**Accomplishments.** Fail-closed by design; 134 end-to-end checks including forged/replayed webhooks, cross-tenant attacks, MFA replay and concurrency; load-tested at 76 req/s; tamper-evident audit.

**What we learned.** The model should narrate, never decide; most agent-payment risk is in retries, ambiguity and stale state.

**What's next.** Real merchant onboarding via Store Sync price baselines, Agent Payments Protocol support, broader rule types, SSO.

**Built with:** TypeScript, Next.js, Google Cloud Run, Vertex AI (Gemini), Neon/Postgres, PayPal REST (Orders v2, Webhooks), Cloud Build, Secret Manager, Cloud Scheduler, Cloud Storage.
