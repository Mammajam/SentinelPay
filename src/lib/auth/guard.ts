import { readSession, SESSION_COOKIE, type Session } from "./session.ts";

/** Dashboard-session auth for READ-ONLY JSON endpoints. Never use for mutating endpoints. */
export function sessionFromRequest(req: Request): Session | null {
  const raw = req.headers.get("cookie")?.split(/;\s*/).find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  try { return readSession(raw); } catch { return null; }
}
