# Draft: PayPal sandbox access from Liberia

Send the same text (lightly adapted) to: (1) the Devpost hackathon Q&A / discussion tab and the hackathon contact listed on https://paypalaihackathon.devpost.com/, and (2) PayPal Developer Support (https://developer.paypal.com/support/ or the developer community forum). Replace the [bracketed] items first. Do not include any secrets.

---

**Subject:** Sandbox access for an entrant based in Liberia (PayPal AI Hackathon 2026)

Hello,

I'm entering the PayPal AI Hackathon with a project called SentinelPay, and I'm writing to ask how to get working PayPal sandbox credentials from Liberia.

**About the project.** SentinelPay is a deterministic guardrail between AI shopping agents and PayPal. A user states spending limits in plain language, an AI model drafts a policy, the user confirms it, and before any payment an agent calls SentinelPay, which returns ALLOW, REQUIRE_REAUTH or DENY from deterministic code. It uses PayPal Orders v2 (create, authorize, capture with idempotency keys) and signed webhooks, and it only captures when the policy allows. The repo is public: [GitHub URL].

**The problem.** The official rules say to use an existing PayPal account or create a free one at developer.paypal.com to access the sandbox. I live in Liberia, and [describe exactly what happens: e.g. "PayPal does not offer account sign-up for Liberia, so I cannot create or verify an account" / "the developer dashboard rejects my country at sign-up"]. As a result, everything I have built and tested so far ran against a local simulator I wrote from the public API documentation, not against PayPal itself. I want to verify the integration against the real sandbox, including real webhook signatures and error responses, before the deadline (Nov 12, 12:00 pm PT).

**My questions.**
1. Can a developer residing in Liberia create a developer.paypal.com account and sandbox app? If so, which country or account type should I choose, and is selecting a different country for the developer account permitted under the hackathon rules?
2. If not, can the organisers or PayPal provide sandbox REST credentials (client ID and secret) for hackathon use, or a sandbox business/personal account pair?
3. Is it acceptable to demonstrate the integration with sandbox credentials supplied by a teammate or mentor, as long as I am the author of the code?
4. If none of these is possible, is a submission that demonstrates the PayPal integration against a faithful, clearly labelled simulator still eligible for Stage One (which checks that the project "reasonably applies the required APIs/SDKs")? I would prefer a real sandbox.

Liberia is not on the rules' list of excluded countries, so I believe I am eligible to enter and want to make sure I can meet the sandbox requirement.

I can share the repository, a deployed demo and my test results on request. Thank you for your help. Because the deadline is Nov 12, a reply within the next few days would be very helpful.

Best regards,
[Name]
[Devpost username] · [email]

---

## What the Devpost rules say (read 2026-10-20)
- Submission period closes **Thu Nov 12, 2026, 12:00 pm Pacific**. Judging Dec 1-15; winners ~Dec 21.
- Open to individuals/teams/organisations; excluded countries are those sanctioned by the US or prohibited by local law (Brazil, Quebec, Russia, Crimea, Cuba, Iran, North Korea named). Liberia is not named.
- Must integrate the PayPal developer platform **using the free sandbox** plus an AI tool/model of your choice. PayPal integration must be central.
- Required: text description; working demo (hosted URL **or** complete setup/run instructions in the repo); **public repo with a detectable open-source licence file**; demo video **under 3 minutes**, **public on YouTube**, no third-party trademarks or copyrighted music; testing credentials if the site is private; English.
- A project that predates Oct 1 must be **significantly updated** after Oct 1, and the entry should explain how.
- Judging: Stage 1 pass/fail (fits theme and reasonably applies the required APIs); Stage 2 equal weights: Technological Implementation, Design, Potential Impact, Innovation, Presentation.
- The rules text I could read was cut off after section 11; the Overview page may add details.
