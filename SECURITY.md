# Security Policy

SentinelPay is **sandbox-stage software and is not production-ready**. See `docs/THREAT_MODEL.md` for known open items.

## Reporting a vulnerability
Please **do not open a public issue**. Use GitHub's private vulnerability reporting
(Security tab → "Report a vulnerability") for this repository.

Include reproduction steps, affected files, and impact. Expect an acknowledgement within 7 days.

## Scope
In scope: policy evaluation bypass, webhook signature/replay flaws, audit-log integrity, auth/tenant isolation, injection into the policy compiler.
Out of scope: findings that require leaked credentials, or issues in third-party services (PayPal, Neon, Google).

## Never commit secrets
`.env*` files are git-ignored (except `.env.example`). If you find a secret in the history, report it privately.
