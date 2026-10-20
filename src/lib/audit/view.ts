/**
 * Human-readable view of audit entries for the dashboard. Pure (no DB, no React) so it is unit-tested.
 * Only TENANT-VISIBLE kinds are listed: chain-level and unauthenticated events (anchors, rejected/received
 * webhooks) carry no tenant and are never shown in a tenant's explorer.
 */
export const TENANT_KINDS = [
  "policy.drafted", "policy.activated", "policy.revoked",
  "cart.validated",
  "order.inspected", "order.captured", "order.capture_failed", "order.capture_retriggered", "order.retrigger_refused",
  "capture.recorded", "capture.unattributed",
  "admin.login", "assistant.query",
] as const;
export type TenantKind = (typeof TENANT_KINDS)[number];
export const GLOBAL_KINDS = ["audit.anchored", "webhook.rejected", "webhook.received", "admin.login_failed"] as const;

export type Tone = "ok" | "warn" | "bad" | "info";
const short = (v: unknown, n = 8) => (typeof v === "string" ? v.slice(0, n) : "?");
const obj = (p: unknown): Record<string, unknown> => (p && typeof p === "object" ? (p as Record<string, unknown>) : {});
const money = (v: unknown) => (typeof v === "number" ? `${(v / 100).toFixed(2)}` : "?");

export function describeAuditEntry(kind: string, payload: unknown): { summary: string; tone: Tone } {
  const p = obj(payload);
  switch (kind) {
    case "policy.drafted": return { summary: `Policy ${short(p.id)} drafted (${String(p.compiler ?? "compiler")})`, tone: "info" };
    case "policy.activated": return { summary: `Policy ${short(p.id)} activated after human confirmation`, tone: "ok" };
    case "policy.revoked": return { summary: `Policy ${short(p.id)} REVOKED (kill-switch)`, tone: "bad" };
    case "cart.validated": {
      const d = String(p.decision ?? "?");
      const codes = Array.isArray(p.violations) ? (p.violations as Array<{ code?: unknown }>).map((v) => String(v.code ?? "?")).join(", ") : "";
      return { summary: `Cart ${String(p.cartId ?? "?")}: ${d}${codes ? ` (${codes})` : ""}`, tone: d === "ALLOW" ? "ok" : d === "DENY" ? "bad" : "warn" };
    }
    case "order.inspected": {
      const d = String(p.decision ?? "?");
      return { summary: `Order ${String(p.orderId ?? "?")} inspected: ${d}`, tone: d === "ALLOW" ? "ok" : d === "DENY" ? "bad" : "warn" };
    }
    case "order.captured": return { summary: `Order ${String(p.orderId ?? "?")} captured${p.retrigger ? " (re-trigger)" : ""}`, tone: "ok" };
    case "order.capture_failed": return { summary: `Capture failed for ${String(p.orderId ?? "?")}: ${String(p.issue ?? `HTTP ${String(p.http ?? "?")}`)}${p.ambiguous ? " (outcome UNKNOWN)" : ""}`, tone: "bad" };
    case "order.capture_retriggered": return { summary: `Capture re-triggered for ${String(p.orderId ?? "?")} (attempt ${String(p.attempt ?? "?")})`, tone: "warn" };
    case "order.retrigger_refused": return { summary: `Re-trigger refused for ${String(p.orderId ?? "?")}: ${String(p.reason ?? "?")}`, tone: "warn" };
    case "capture.recorded": return { summary: `Capture ${short(p.captureId, 12)} recorded: ${money(p.amount)}${p.newlyRecorded === false ? " (replay ignored)" : ""}`, tone: "ok" };
    case "capture.unattributed": return { summary: "Capture event could not be attributed to a policy", tone: "warn" };
    case "admin.login": return { summary: `Operator signed in (key ${short(p.keyId)})`, tone: "info" };
    case "assistant.query": return { summary: `Assistant used: ${Array.isArray(p.toolsUsed) && p.toolsUsed.length ? (p.toolsUsed as unknown[]).join(", ") : "no tools"}`, tone: "info" };
    default: return { summary: kind, tone: "info" };
  }
}

/** JSON for the detail panel, bounded so one huge payload cannot bloat the response. */
export function boundedPayload(payload: unknown, maxChars = 2000): string {
  let s: string;
  try { s = JSON.stringify(payload ?? null, null, 2) ?? "null"; } catch { return "(unserialisable)"; }
  return s.length > maxChars ? `${s.slice(0, maxChars)}\n… (truncated)` : s;
}
