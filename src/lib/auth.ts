import { createHash } from "node:crypto";
import { safeEq } from "./paypal/webhook.ts";

/**
 * PLACEHOLDER authentication (bearer API keys, compared by hash in constant time).
 * Roles are separated on purpose: an `agent` key can ONLY validate carts; only an
 * `admin` (human operator) key can compile/confirm policies. Replace with a real
 * IdP + MFA for admin actions before any production use (see docs/THREAT_MODEL.md T6).
 */
export type Role = "agent" | "admin";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function authorize(req: Request, role: Role): { ok: true; principal: string } | { ok: false } {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const configured = (process.env[role === "admin" ? "SENTINEL_ADMIN_KEYS" : "SENTINEL_AGENT_KEYS"] ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean); // each entry: sha256 hex of a key
  if (!token) return { ok: false };
  const h = sha(token);
  const match = configured.some((k) => safeEq(k, h));
  return match ? { ok: true, principal: `${role}:${h.slice(0, 8)}` } : { ok: false };
}

export const unauthorized = () => Response.json({ error: "unauthorized" }, { status: 401 });
