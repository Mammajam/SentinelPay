import { db } from "./db/client.ts";

/**
 * Fixed-window rate limiting backed by Postgres, so limits hold across serverless instances
 * (an in-memory Map would give every cold instance a fresh budget). Fails CLOSED: if the limiter
 * cannot be consulted, the request is refused (503) rather than allowed unmetered.
 */
const num = (v: string | undefined, d: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

export const LIMITS = {
  /** per API key */
  validate: () => ({ limit: num(process.env.RL_VALIDATE_PER_MIN, 600), windowSec: 60 }),
  /** LLM cost control, per tenant */
  compile: () => ({ limit: num(process.env.RL_COMPILE_PER_HOUR, 10), windowSec: 3600 }),
  compileDaily: () => ({ limit: num(process.env.RL_COMPILE_PER_DAY, 50), windowSec: 86_400 }),
  assistant: () => ({ limit: num(process.env.RL_ASSISTANT_PER_HOUR, 30), windowSec: 3600 }),
  /** brute-force protection, per client IP */
  login: () => ({ limit: num(process.env.RL_LOGIN_PER_15MIN, 5), windowSec: 900 }),
};

export interface Consumed { allowed: boolean; count: number; retryAfterSec: number }

export async function consume(bucket: string, limit: number, windowSec: number): Promise<Consumed> {
  const { rows } = await db().query(
    `WITH w AS (SELECT to_timestamp(floor(extract(epoch from now()) / $2) * $2) AS ws, extract(epoch from now()) AS nowe)
     INSERT INTO rate_limits (bucket, window_start, count)
       SELECT $1, ws, 1 FROM w
     ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
     RETURNING count, extract(epoch from window_start) + $2 - extract(epoch from now()) AS retry`,
    [bucket, windowSec],
  );
  const count = Number(rows[0].count);
  if (Math.random() < 0.01) db().query("DELETE FROM rate_limits WHERE window_start < now() - interval '2 days'").catch(() => {});
  return { allowed: count <= limit, count, retryAfterSec: Math.max(1, Math.ceil(Number(rows[0].retry))) };
}

/** Returns a ready 429/503 Response when the caller must stop, or null to proceed. */
export async function guard(bucket: string, cfg: { limit: number; windowSec: number }): Promise<Response | null> {
  try {
    const r = await consume(bucket, cfg.limit, cfg.windowSec);
    if (r.allowed) return null;
    return Response.json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": String(r.retryAfterSec) } });
  } catch {
    return Response.json({ error: "rate_limiter_unavailable" }, { status: 503 });
  }
}

export const clientIp = (req: Request) =>
  req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
