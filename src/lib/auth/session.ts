import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless signed session cookie for the DASHBOARD ONLY (read access).
 * Mutating APIs never accept it: they need a Bearer key (+ TOTP for sensitive actions),
 * which also makes the cookie irrelevant to CSRF against state-changing endpoints.
 * SESSION_SECRET must be >= 32 chars; absent/short => sessions are refused (fail closed).
 */
export const SESSION_COOKIE = "sp_session";
export const SESSION_TTL_SEC = 30 * 60;

export interface Session { tenantId: string; keyId: string; exp: number }

function secret(env: Record<string, string | undefined>): Buffer {
  const s = env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be set (>= 32 chars)");
  return Buffer.from(s);
}
const mac = (body: string, env: Record<string, string | undefined>) =>
  createHmac("sha256", secret(env)).update(body).digest("base64url");

export function signSession(s: Omit<Session, "exp">, now = new Date(), env: Record<string, string | undefined> = process.env): string {
  const body = Buffer.from(JSON.stringify({ ...s, exp: Math.floor(now.getTime() / 1000) + SESSION_TTL_SEC })).toString("base64url");
  return `${body}.${mac(body, env)}`;
}

export function readSession(token: string | undefined, now = new Date(), env: Record<string, string | undefined> = process.env): Session | null {
  if (!token) return null;
  try {
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    const want = Buffer.from(mac(body, env)), got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    const s = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Session;
    if (typeof s.tenantId !== "string" || typeof s.keyId !== "string" || typeof s.exp !== "number") return null;
    return s.exp > Math.floor(now.getTime() / 1000) ? s : null;
  } catch {
    return null;
  }
}
