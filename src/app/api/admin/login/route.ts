import { z } from "zod";
import { authenticateToken, hashKey } from "@/lib/auth/keys.ts";
import { SESSION_COOKIE, SESSION_TTL_SEC, signSession } from "@/lib/auth/session.ts";
import { clientIp, guard, LIMITS } from "@/lib/ratelimit.ts";
import { appendAudit } from "@/lib/db/audit.ts";

const Body = z.object({ key: z.string().min(10).max(200), totp: z.string().regex(/^\d{6}$/) });

/**
 * Dashboard login: admin API key + current TOTP code -> short-lived, signed, HttpOnly,
 * SameSite=Strict cookie that grants READ-ONLY dashboard access. Brute-force is bounded per IP
 * and per key, so rotating IPs does not help against one key.
 */
export async function POST(req: Request) {
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "invalid_request" }, { status: 400 });

  const limited =
    (await guard(`login:ip:${clientIp(req)}`, LIMITS.login())) ??
    (await guard(`login:key:${hashKey(body.data.key).slice(0, 16)}`, { limit: 10, windowSec: 900 }));
  if (limited) return limited;

  const auth = await authenticateToken(body.data.key, "admin", body.data.totp);
  if (!auth.ok) {
    await appendAudit("admin.login_failed", { reason: auth.code }).catch(() => {});
    // Uniform message: do not reveal whether the key or the code was wrong.
    return Response.json({ error: "invalid_credentials" }, { status: auth.status === 503 ? 503 : 401 });
  }

  let token: string;
  try {
    token = signSession({ tenantId: auth.principal.tenantId, keyId: auth.principal.keyId });
  } catch {
    return Response.json({ error: "sessions_unavailable" }, { status: 503 });
  }
  await appendAudit("admin.login", { tenantId: auth.principal.tenantId, keyId: auth.principal.keyId }).catch(() => {});

  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return new Response(JSON.stringify({ ok: true, tenantId: auth.principal.tenantId }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_SEC}${secure}`,
    },
  });
}
