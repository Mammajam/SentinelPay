# Dependency Audit Triage

## 2026-10-07 — `npm audit`
| Scope | Result |
|---|---|
| Production deps (`npm audit --omit=dev`) | **0 vulnerabilities** |
| All deps | 5 high, all in one dev-only chain |

Chain: `eslint-config-next` → `@next/eslint-plugin-next` → `fast-glob` → `micromatch` → `braces@3.0.3`
Advisory: [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) — `braces` stack exhaustion (DoS) on deeply nested glob patterns. Affected range `<=3.0.3`.

**Decision: accept, do not "fix".**
- `braces@3.0.3` is already the newest release; there is no patched version to upgrade to.
- `npm audit fix --force` offers `eslint-config-next@14.2.35`, a **downgrade across two majors** that is incompatible with Next 16. Rejected.
- Exposure is nil in practice: the chain runs only inside ESLint on developers' machines and CI, over glob patterns we author, never over attacker-supplied input. It is not in the shipped bundle.

**Controls**
- CI runs `npm audit --omit=dev --audit-level=high` — any production-dependency vulnerability fails the build.
- Dependabot alerts + security updates are enabled; revisit when `braces`/`micromatch` publish a fix.
- Note: an earlier count of "22 vulnerabilities" came from a partial first install of the scaffold; the real, resolved tree has 5.
