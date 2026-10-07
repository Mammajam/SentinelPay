# O2 — Inquiry to PayPal / Braintree (draft)

**Purpose:** get a written answer on whether a third party may sit in the agentic-payment token path. Until answered, SentinelPay stays **decision-only** (it never receives, stores, or forwards payment tokens).

**Where to send (in order of preference)**
1. Your PayPal/Braintree **account manager or partner contact**, if any (fastest, and gives a named owner).
2. **PayPal Developer support** (developer.paypal.com → Support) — select the Agentic Commerce / Agent Ready topic and include the sandbox app id.
3. **Braintree support** (from the Braintree control panel → Help/Contact) for the ACP/UCP *token-processing* half of the question.
4. The contact path listed on the Agent Ready / Store Sync onboarding pages at docs.paypal.ai (these programs have enrollment steps; the enrollment contact can usually answer partner-architecture questions).

Ask for the answer **in writing**, and for the doc section it is based on.

---

**Subject:** Agent Ready — can a third-party risk service sit between the AI agent and the merchant's Braintree processing?

Hello,

We are building SentinelPay, a policy-verification service for agentic checkout. We are integrating with PayPal Agent Ready (ACP via ChatGPT, UCP via Google AI Mode/Gemini) and Store Sync, and want to confirm what is permitted before designing anything.

Our docs reading is that, for ACP, the merchant app receives a delegated token to process through Braintree, and for UCP, the merchant receives a single-use Google Pay token to process through Braintree. Please confirm or correct the following:

1. **Token path.** May a party other than the merchant (or its PCI-scoped processor) receive or forward ACP delegated tokens or UCP Google Pay tokens? If so, under what program, contract, or PCI requirements? If not, is a merchant-hosted component that calls our service with *amounts only* (no token) acceptable?
2. **Pre-capture checks.** Is there a supported hook where a merchant-authorized service can approve or reject an order after `CHECKOUT.ORDER.APPROVED` and before capture? Is the recommended pattern to withhold the capture call?
3. **Capture credentials.** Can a service hold scoped credentials that can *capture only* (not refund or create payouts) for a merchant's orders?
4. **Webhooks.** Please confirm the current signature-verification procedure and header set for Agentic Commerce webhooks, and whether the `PAYMENT_ERROR` / `PRICING_ERROR` ValidationIssue enums in the public definition are complete and stable.
5. **Seller protection.** Does routing the order through a merchant-authorized verification service affect Seller Protection or Purchase Protection eligibility?
6. **Store Sync.** Is there an API or export for reading a merchant's synced catalog prices (as a baseline for price-drift checks), beyond the merchant's own feed?

Context: sandbox only; no production traffic. Sandbox app id: `<fill in>`. Contact: `<name / email>`.

Thank you,
`<name>`

---

**When the answer arrives:** record it in `docs/SPEC_ADDENDUM.md` (close O2) and update `docs/COMPLIANCE_SCOPING.md` C1/C2. If tokens in the path are disallowed, v1 is final as designed; if allowed, a PCI scoping exercise comes first.
