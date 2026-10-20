/** Shapes mirrored from the read-only dashboard JSON APIs. */
export interface Violation { rule: string; code: string; message: string }
export interface Decision { id: number; policyId: string; cartId: string; decision: "ALLOW" | "REQUIRE_REAUTH" | "DENY"; violations: Violation[]; at: string }
export interface PolicyView { id: string; status: "draft" | "active" | "revoked"; hash: string; directive: string; rules: string[]; createdAt: string }
export interface ExceptionView { orderId: string; policyId: string; issue: string | null; ambiguous: boolean; actionType: string; attempt: number; at: string }
export interface AuditRow { id: string; kind: string; at: string; hash12: string; summary: string; tone: "ok" | "warn" | "bad" | "info"; payload: string; selfHashOk: boolean }
export interface LedgerRow { id: number; policyId: string; captureId: string; amount: number; currency: string; at: string }
export interface LedgerTotal { currency: string; count: number; total: number }
export interface KeyRow { id: string; role: "agent" | "admin"; label: string; prefix: string; createdAt: string; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null; status: "active" | "revoked" | "expired" }
export interface MerchantRow { merchantId: string }
