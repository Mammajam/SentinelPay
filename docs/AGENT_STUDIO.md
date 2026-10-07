# Agentic capabilities & Google Agent Studio

SentinelPay is agentic in two directions. **Neither can move money or change policy.**

## 1. SentinelPay as a tool for your Agent Studio agent (OpenAPI)
A shopping agent you build in Google's Agent Studio / Gemini Enterprise calls SentinelPay *before* paying.

- Spec: `GET /api/agent/openapi` (public, secret-free). Exactly two operations: `validateCart`, `getPolicy`.
- Auth: `Authorization: Bearer <agent key>` (`sp_agt_…`). The tenant comes from the key.
- Create the key: `npm run admin -- key --tenant <id> --role agent --label "agent-studio"` (shown once).
- Agent instruction to add: *"Always call validateCart before any payment. If the decision is DENY or REQUIRE_REAUTH, or the call fails, do not pay: tell the user and ask them to re-authorize. Never alter cart numbers to get an ALLOW."*

**In Agent Studio (verify labels in your console; they change):** create/open the agent → add a tool → choose OpenAPI → import `https://<your-host>/api/agent/openapi` (or paste the JSON) → set authentication to API key / Bearer with your agent key. Your deployment must be reachable over HTTPS (a `localhost` app is not reachable from Google). Alternatively expose the same endpoints through Apigee as MCP tools.

## 2. The operator assistant (inside SentinelPay)
`POST /api/agent/assistant {"question": "..."}` with an **admin** key. A Gemini function-calling loop (GEAP/Gemini via `GEAP_PROJECT` or `GOOGLE_API_KEY`) answers questions such as *"why were my last carts denied?"* using three tools: `list_recent_decisions`, `explain_policy`, `dry_run_cart`.

Safety properties (unit-tested, `tests/phase4.test.ts`): read-only/dry-run tools only; tenant bound from the authenticated key (never a tool argument); zod-validated args; unknown tools refused; result size cap; max 4 steps; tool output treated as untrusted data; usage audited (tool names only, never question text).

## Not done / needs you
- Live Gemini calls need billing (AI Studio credits were depleted; the endpoint returns 502 until funded).
- Not verified against a real Agent Studio project (needs your GCP access).
- MCP server transport is not implemented; Gemini Enterprise custom-MCP requires OAuth 2.0 and an admin-enabled feature.
