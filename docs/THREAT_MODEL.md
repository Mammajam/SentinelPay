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
| T6 | Stolen/shared API key; no MFA for admin | 1,2 | Hashed keys, constant-time compare, role split. **Placeholder** — needs IdP + MFA + rotation + per-key rate limits | P |
| T7 | Evaluator bypass via inconsistent cart (agent asserts a low `total`) | 2 | Total must reconcile with lines+tax+shipping, else DENY | M |
| T8 | Stale/missing price baseline treated as "no drift" | 2 | Missing or stale baseline => DENY | M |
| T9 | Float rounding allows over-limit by a cent | all | Integer minor units; basis-point drift math; no floats | M |
| T10 | Proxy outage lets checkouts bypass checks | 2 | Every internal error path returns DENY (HTTP 503); capture is only ever initiated by SentinelPay after ALLOW. **Requires** that merchants/agents cannot capture directly — deployment constraint, see O1 | P |
| T11 | Audit log tampering or deletion by an insider | 4 | Hash chain + DB triggers blocking UPDATE/DELETE; chain verified on dashboard. A DB superuser can still rewrite the whole chain — needs periodic external anchoring (O4) | P |
| T12 | Policy edited after approval | 4 | `policies_freeze` trigger; new limits = new policy + new confirmation | M |
| T13 | Tenant data leakage | 4 | `owner_id` column exists but **no row-level authorization on reads yet** | O |
| T14 | Secrets exposure (PayPal secret, DB URL) | all | Env-only; `.env*` git-ignored; no secrets in logs/audit payloads. Needs a secret manager in prod | P |
| T15 | SSRF via cert fetch | 5 | URL allowlist before fetch; `redirect: "error"`; 5s timeout | M |
| T16 | DoS / compile-endpoint cost abuse | 1,3 | Input length cap only. Needs rate limiting + quotas | O |
| T17 | Payment-token custody (PCI scope creep) | 5 | Design rule: SentinelPay stores **no PAN, no raw tokens**; see COMPLIANCE_SCOPING.md | M (by design; token interception unverified, O2) |

## Fail-closed contract
Decision values: `ALLOW | REQUIRE_REAUTH | DENY`. `ALLOW` is returned only when every rule passes and all integrity checks pass. Parse errors, unknown rule kinds, currency mismatch, unreadable ledger, DB errors and unrecognized PayPal issue codes all resolve to `DENY` (or `HALT`).

## Open items
- **O1** Enforce SentinelPay as the *only* capture path (PayPal-side credential scoping / merchant config).
- **O4** External anchoring of audit chain head (e.g., periodic hash to object-lock storage).
- Rate limiting, IdP/MFA, tenant read isolation (T6, T13, T16).
