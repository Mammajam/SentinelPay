# Demo video script (target 2:45, hard limit < 3:00)

Devpost rules (read 2026-10-20): under 3 minutes, public on YouTube, shows the project running, **no third-party trademarks or copyrighted music** (use no music or royalty-free/own audio; avoid showing PayPal logos beyond what the product UI itself shows). English narration. Judges may stop at 3:00, so the end-to-end proof must land before 2:30.

## Honesty rule
Label every PayPal segment on screen: **"PayPal sandbox"** only if the run really used `api-m.sandbox.paypal.com`; otherwise **"local PayPal simulator"**. Never imply the simulator is PayPal. Record the sandbox take only after O5 is closed.

## Pre-recording checklist
- Throwaway demo tenant + admin key + authenticator (not the real ones); delete afterwards.
- Dashboard in a clean browser profile, dark mode off, 1440x900, zoom 110%.
- Seed data: one ALLOW order, one over-limit REQUIRE_REAUTH, one injected-price DENY, one failed capture in the exception queue.
- Close notifications; hide env files and terminals showing secrets.

## Shot list
| Time | On screen | Narration |
|---|---|---|
| 0:00-0:15 | Title card, then a one-line agent chat buying a laptop | "AI agents can now check out for us. But models hallucinate, get prompt-injected, and prices change mid-checkout. Who checks the cart before PayPal moves money?" |
| 0:15-0:40 | Compile screen: type "laptop under $1,200, tax and shipping under $150, only this merchant" | "SentinelPay turns plain language into a strict policy. Claude drafts it, but the model never decides anything." |
| 0:40-0:55 | Plain-English readback, hash, enter one-time code | "A deterministic readback shows exactly what will be enforced. I confirm with a single-use code." |
| 0:55-1:20 | Agent calls validateCart: ALLOW, then REQUIRE_REAUTH, then DENY (injected "ignore limits" directive compiles to a harmless rule) | "Pure code returns ALLOW, REQUIRE_REAUTH or DENY. Anything unclear fails closed." |
| 1:20-1:55 | PayPal order -> approve -> signed webhook -> inspected -> captured on ALLOW; over-limit order NOT captured | "Orders are re-inspected from PayPal's own data, and capture happens only on ALLOW, with idempotency so a retry never double-charges." |
| 1:55-2:15 | Revoke policy (kill switch); next order denied | "One click revokes. The next order is denied." |
| 2:15-2:40 | Dashboard tour on AG Grid: Decisions red rows, Audit explorer, Ledger totals, Exceptions re-trigger | "Every decision lands in a tamper-evident audit chain anchored hourly to locked storage. The operator grid filters, exports and live-updates." |
| 2:40-2:55 | Operator assistant answers "why was order X denied?" (read-only); architecture slide; repo URL | "The assistant explains but cannot move money. Open source, Apache-2.0: github.com/Mammajam/SentinelPay." |

## Recording notes
- Record in segments, cut hard; no intro animation.
- Captions on, because the narration may be judged without audio.
- Upload to YouTube as **Public** (not Unlisted), paste the URL in the Devpost form, then open it in a private window to verify.
