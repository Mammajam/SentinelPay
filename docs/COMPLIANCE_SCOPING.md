# Compliance Scoping (v0.1) — NOT LEGAL ADVICE

This is an engineering scoping document to drive questions for qualified counsel and a QSA. Nothing here is a legal conclusion.

## 1. Design principle: minimise scope
SentinelPay is designed as a **decision proxy, not a payment handler**:
- It stores **no card numbers (PAN), CVV, or raw payment tokens**.
- It receives order *amount data* and returns an ALLOW / DENY / REQUIRE_REAUTH decision.
- Money movement (capture) is requested via PayPal REST APIs using the merchant's/platform's PayPal credentials.

## 2. Questions that determine scope (must be answered before production)
| # | Question | Why it matters |
|---|----------|----------------|
| C1 | Will SentinelPay ever *see* ACP delegated tokens or UCP Google Pay tokens? | If yes, it may be in PCI DSS scope (service provider). PayPal docs describe these tokens being processed by the **merchant through Braintree**; a third-party interception point is unverified and may be contractually or technically disallowed. |
| C2 | Does SentinelPay initiate capture with its own credentials, or only advise the merchant system? | Capture-initiation looks closer to a payment-facilitator role. Advice-only keeps it a technical/risk service. |
| C3 | Does it hold or move funds, even transiently? | Money-transmitter licensing (US state-by-state / FinCEN, EU PSD2). Design says **no**. |
| C4 | Whose agreement governs? | PayPal developer/partner terms for Agent Ready & Store Sync; OpenAI/Google platform terms; Braintree terms. |
| C5 | Personal data inventory | `owner_id`, directive text (may contain personal context), cart contents, order ids => GDPR/CCPA. Needs DPA, retention schedule, deletion path (audit log is append-only: store **references/hashes, not personal data**, in audit payloads). |
| C6 | Liability allocation | The pitch ("reduced liability for platforms") needs contracts; a technical control does not by itself shift legal liability or preserve PayPal Seller Protection eligibility. |

## 3. Preliminary posture
- **PCI DSS**: target SAQ-A–equivalent boundary by never touching card data; revisit if C1 = yes.
- **Retention**: audit entries must contain identifiers only. The directive text lives in `policies.source_text` (deletable); audit holds ids/hashes.
- **Security program**: SOC 2 Type II is the realistic customer ask; the threat model and append-only audit log are groundwork.
- **Sandbox only** until C1–C4 are answered with counsel and PayPal.
