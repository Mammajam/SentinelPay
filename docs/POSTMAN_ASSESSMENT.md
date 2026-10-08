# Should SentinelPay use PayPal's Postman collections? (assessed 2026-10-08)

**Verdict: yes, but only as a developer-time contract-checking tool, not as a project component, and it is low priority until two unknowns are resolved.** It replaces nothing we built and adds no runtime dependency.

## Evidence quality (read this first)
- `https://www.postman.com/paypal` could **not** be viewed: the fetch returned an empty shell (the site is JavaScript-rendered) and the browser returned **Cloudflare 525 "SSL handshake failed"** (Postman's origin was failing). So I have **not** seen the workspace listing, fork counts or last-updated dates.
- What I did verify: PayPal's official [Postman guide](https://developer.paypal.com/api/rest/postman/) and the [Postman blog post](https://blog.postman.com/paypal-public-postman-collection/) (**May 2022**, i.e. old). Neither lists the collection's contents beyond an **Orders** example, neither mentions **Agentic Commerce, Store Sync, Agent Ready, Webhooks or Flows**.

## What it would give us
| Need | Value | Why |
|---|---|---|
| Check our **Orders v2** assumptions (shapes, `intent`, breakdown, capture, `PayPal-Request-Id`, error bodies) against PayPal's own requests | **Medium** | Executable reference; lets us replace simulator guesses with real payloads. Orders v2 is the part we use most. |
| Verify **agentic** specifics (`POST /merchant-cart`, `ValidationIssue` enums) | **High if present, none if not** | This is our actual domain and our biggest unverified area (O5). The guide/blog do not say it is covered. |
| Cross-check our **webhook signature verifier** | **Medium, needs credentials** | PayPal exposes a verify-signature API that could be called with a real event; needs an app and a webhook. |
| Unblock work despite **no sandbox account (Liberia)** | **Unknown** | The guide says a *default* token is generated if you supply no credentials. Whether that works for sandbox Orders calls without your own account is **unverified**; the buyer approval step uses sandbox personal accounts from the Developer Dashboard, which you cannot create. |
| Replace our simulator / e2e suite | **None** | Postman cannot receive webhooks (needs a public URL), cannot inject faults, and cannot run unattended in a public repo's CI without secrets. |

## Realistic risks
- **Secrets**: forking puts `client_id`/`client_secret` into Postman's cloud-synced workspace. Use sandbox credentials only, keep values in the *current value* column (not synced), never production.
- **Staleness**: the blog is from 2022; treat the collection as a hint and re-verify against current docs.
- **Account**: forking requires a free Postman account (browsing does not).
- **Provenance**: only fork collections published by the verified `paypal` publisher.

## Decision rule
1. When postman.com is reachable, spend ~10 minutes: (a) is there an Agentic Commerce / `merchant-cart` collection? (b) does *Create Order* work with the default token and no credentials of ours? (c) do examples include error responses?
2. **If (a) yes** → worthwhile: capture real payloads/errors as fixtures and diff the `ValidationIssue` enums against `src/lib/paypal/errors.ts`; this would close much of O5 even without our own sandbox.
3. **If (a) no and (b) no** → skip; rely on PayPal's published API reference and the simulator until sandbox access exists.
4. Either way: no code changes now.
