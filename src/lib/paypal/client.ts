/**
 * Minimal PayPal REST client (OAuth client-credentials + authenticated fetch).
 *
 * SAFETY RAIL: the live hosts are refused unless PAYPAL_ALLOW_LIVE=1. SentinelPay is
 * sandbox-stage (see docs/COMPLIANCE_SCOPING.md); a mistyped PAYPAL_BASE_URL must not
 * be able to move real money.
 */
const LIVE_HOSTS = new Set(["api-m.paypal.com", "api.paypal.com"]);

export function baseUrl(env: Record<string, string | undefined> = process.env): string {
  const raw = env.PAYPAL_BASE_URL ?? "https://api-m.sandbox.paypal.com";
  const host = new URL(raw).hostname;
  if (LIVE_HOSTS.has(host) && env.PAYPAL_ALLOW_LIVE !== "1") {
    throw new Error("Refusing to call live PayPal host (set PAYPAL_ALLOW_LIVE=1 only after the production checklist)");
  }
  return raw.replace(/\/$/, "");
}

const tokens = new Map<string, { token: string; expiresAt: number }>();

export async function accessToken(): Promise<string> {
  const base = baseUrl();
  const hit = tokens.get(base);
  if (hit && hit.expiresAt > Date.now() + 30_000) return hit.token;

  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not configured");

  const res = await fetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`PayPal OAuth failed (${res.status})`);
  const j = (await res.json()) as { access_token: string; expires_in: number };
  tokens.set(base, { token: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 });
  return j.access_token;
}

export interface PayPalInit {
  method?: "GET" | "POST";
  body?: string;
  /** Sent as PayPal-Request-Id (idempotency). */
  requestId?: string;
}

export type PayPalCall = (path: string, init?: PayPalInit) => Promise<Response>;

export const paypalFetch: PayPalCall = async (path, init = {}) => {
  const headers: Record<string, string> = {
    authorization: `Bearer ${await accessToken()}`,
    "content-type": "application/json",
  };
  if (init.requestId) headers["paypal-request-id"] = init.requestId;
  return fetch(`${baseUrl()}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body,
    signal: AbortSignal.timeout(10_000),
  });
};
