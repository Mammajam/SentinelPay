import { safeEq } from "@/lib/paypal/webhook.ts";
import { createAnchor, verifyAnchors } from "@/lib/db/anchor.ts";

/**
 * Platform-level (not tenant) endpoint, meant for a scheduler (Vercel Cron, Cloud Scheduler).
 * Auth: `Authorization: Bearer $CRON_SECRET`. Absent/short secret => disabled (503).
 *   POST -> commit the current audit-chain head
 *   GET  -> re-verify every stored anchor against the live chain
 */
function cronAuth(req: Request): Response | null {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) return Response.json({ error: "not_configured" }, { status: 503 });
  const given = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  return safeEq(given, secret) ? null : Response.json({ error: "unauthorized" }, { status: 401 });
}

export async function POST(req: Request) {
  const bad = cronAuth(req);
  if (bad) return bad;
  try {
    const a = await createAnchor();
    return Response.json(a ?? { anchored: false, reason: "empty_chain" });
  } catch {
    return Response.json({ error: "anchor_failed" }, { status: 502 });
  }
}

export async function GET(req: Request) {
  const bad = cronAuth(req);
  if (bad) return bad;
  try {
    return Response.json(await verifyAnchors());
  } catch {
    return Response.json({ error: "internal" }, { status: 500 });
  }
}
