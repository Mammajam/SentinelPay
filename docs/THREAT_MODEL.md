# SentinelPay Threat Model (v0.1)

Method: STRIDE over the trust boundaries below. Status: **M** = mitigated in code, **P** = partially, **O** = open (design only).

```
[Shopper/Admin] --(1)--> [SentinelPay API] <--(2)-- [AI Agent (UNTRUSTED)]
                              |  \
                              |   (3) Gemini/GEAP compiler (UNTRUSTED output)
                              |
                         (4) Neon Postgres        (5) PayPal APIs + Webhooks (semi-trusted, signed)
```

Trust stance: the agent, the compiler's output, cart contents and any webhook not signature-verified are **untrusted input**.

| ID | Threat | Boundary | Mitigation | Status |
|----|--------|----------|-----------|--------|
| T1 | Prompt injection makes the agent request an over-limit purchase | 2 | Limits live outside agent context; evaluator is pure/deterministic; agent only holds an `agent` key that can validate, never edit policy | M |
| T2 | Injection in the *directive text* tricks the compiler into a permissive policy | 3 | Compiler has no tools; strict zod schema; DRAFT only; deterministic readback shown to a human; activation requires echoing the policy hash; compiled body frozen by DB trigger once active | M |
| T3 | Forged webhook (attacker-supplied `PAYPAL-CERT-URL`) | 5 | Cert URL host/path/https allowlist; RSA signature over `id\|time\|webhookId\|crc32(rawBody)`; raw-body verification; 5-min timestamp window | M |
| T4 | Webhook replay | 5 | `webhook_events.event_id` primary key; timestamp window | M |
| T5 | Double charge from retry | 5 | Deterministic `PayPal-Request-Id`; `DUPLICATE_INVOICE_ID` => look up order, never blind retry | M (capture call itself is O) |
| T6 | Stolen/shared API key; no MFA for admin | 1,2 | Keys are tenant-scoped, SHA-256 hashed at rest, revocable, expiring; role split (`agent` can only validate/read, `admin` manages). **Policy confirmation and dashboard login require a single-use TOTP** (RFC 6238, replay-blocked, seed sealed with AES-256-GCM). Residual: no external IdP/SSO yet; key distribution and rotation are manual | P (was open) |
| T7 | Evaluator bypass via inconsistent cart (agent asserts a low `total`) | 2 | Total must reconcile with lines+tax+shipping, else DENY | M |
| T8 | Stale/missing price baseline treated as "no drift" | 2 | Missing or stale baseline => DENY | M |
| T9 | Float rounding allows over-limit by a cent | all | Integer minor units; basis-point drift math; no floats | M |
| T10 | Proxy outage lets checkouts bypass checks | 2 | Every internal error path returns DENY (HTTP 503); capture is only ever initiated by SentinelPay after ALLOW. **Requires** that merchants/agents cannot capture directly — deployment constraint, see O1 | P |
| T11 | Audit log tampering or deletion by an insider | 4 | Hash chain + DB triggers blocking UPDATE/DELETE; chain verified on dashboard; **periodic anchors** (append-only table, optional signed external HTTP sink) re-verified against the live chain. **Residual: without `ANCHOR_SINK_URL` a DB superuser can rewrite both chain and anchors** — real protection needs the external sink (O4 partially closed) | P |
| T12 | Policy edited after approval | 4 | `policies_freeze` trigger; new limits = new policy + new confirmation | M |
| T13 | Tenant data leakage | 4 | Tenant derived from the key, never from input; every policy read/activate is tenant-scoped (other tenants' ids look missing); dashboard queries scoped by tenant; merchants bound to exactly one tenant and checked on both validate-cart and webhook paths (blocks cross-tenant policy use and budget burning). 86-check e2e proves it | M |
| T14 | Secrets exposure (PayPal secret, DB URL) | all | Env-only; `.env*` git-ignored; no secrets in logs/audit payloads; `SENTINEL_MASTER_KEY` is the single root secret (fails closed if missing). Residual: still plain env vars — use a managed secret store in production | P |
| T15 | SSRF via cert fetch | 5 | URL allowlist before fetch; `redirect: "error"`; 5s timeout | M |
| T16 | DoS / compile-endpoint cost abuse | 1,3 | Postgres-backed fixed-window limits (work across serverless instances): per-key validate, per-tenant compile (hourly + daily quota), per-IP and per-key login, per-tenant assistant. Limiter outage => refuse (fail closed). Residual: no network-layer DDoS protection (use the platform/CDN) | M |
| T17 | Payment-token custody (PCI scope creep) | 5 | Design rule: SentinelPay stores **no PAN, no raw tokens**; see COMPLIANCE_SCOPING.md | M (by design; token interception unverified, O2) |

## Fail-closed contract
Decision values: `ALLOW | REQUIRE_REAUTH | DENY`. `ALLOW` is returned only when every rule passes and all integrity checks pass. Parse errors, unknown rule kinds, currency mismatch, unreadable ledger, DB errors and unrecognized PayPal issue codes all resolve to `DENY` (or `HALT`).

## New surface added in Phase 4
| ID | Threat | Mitigation | Status |
|----|--------|-----------|--------|
| T18 | Dashboard session theft / CSRF | HttpOnly, SameSite=Strict, 30-min HMAC-signed cookie; grants **read-only** access; mutating APIs ignore it (Bearer + MFA only) | M |
| T19 | Operator-assistant prompt injection | Tool set is read-only/dry-run (a unit test forbids write-ish tool names); tenant bound from the key, not tool args; args zod-validated; unknown tools refused; results capped; step-bounded | M |
| T20 | External agent (Agent Studio) over-reach | OpenAPI exposes exactly two operations (`validateCart`, `getPolicy`); no compile/activate/capture; agent keys are tenant-scoped and rate-limited | M |
| T21 | Capture event attributed to a policy it was not authorized under | `PAYMENT.CAPTURE.COMPLETED` is attributed via `custom_id`; the order-approval path is merchant-bound, but the capture handler does not re-check provenance. Needs the order-id link from real PayPal payloads | O |

## Open items
- **O1** Enforce SentinelPay as the *only* capture path (PayPal-side credential scoping / merchant config).
- **O4** External anchoring of audit chain head (e.g., periodic hash to object-lock storage).
- External IdP/SSO and managed secret store (T6, T14); external anchor sink in production (T11); capture provenance (T21).
