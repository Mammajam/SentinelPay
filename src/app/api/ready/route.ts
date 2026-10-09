import { db } from "@/lib/db/client.ts";

/** Readiness: the database answers. Reading headers makes this per-request (never prerendered). */
export async function GET(req: Request) {
  void req.headers;
  try {
    await db().query("SELECT 1");
    return Response.json({ ready: true });
  } catch {
    return Response.json({ ready: false }, { status: 503 });
  }
}
