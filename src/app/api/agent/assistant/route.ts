import { z } from "zod";
import { authenticate, denied } from "@/lib/auth/keys.ts";
import { guard, LIMITS } from "@/lib/ratelimit.ts";
import { getAssistantModel, makeBackend, runAssistant } from "@/lib/agent/assistant.ts";
import { appendAudit } from "@/lib/db/audit.ts";

const Body = z.object({ question: z.string().min(2).max(1000) });

/**
 * Operator assistant: ask questions about your tenant's decisions and policies in natural language.
 * Admin key required. Tools are read-only / dry-run and tenant-bound (see lib/agent/assistant.ts).
 */
export async function POST(req: Request) {
  const auth = await authenticate(req, "admin");
  if (!auth.ok) return denied(auth);
  const { tenantId, keyId } = auth.principal;

  const limited = await guard(`assistant:${tenantId}`, LIMITS.assistant());
  if (limited) return limited;

  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return Response.json({ error: "invalid_request" }, { status: 400 });

  let model;
  try { model = getAssistantModel(); } catch { return Response.json({ error: "assistant_unavailable" }, { status: 503 }); }

  try {
    const out = await runAssistant(body.data.question, makeBackend(tenantId), model);
    // Audit usage (tools only — never the question text, which may contain personal data).
    await appendAudit("assistant.query", { tenantId, keyId, toolsUsed: out.toolsUsed, steps: out.steps }).catch(() => {});
    return Response.json(out);
  } catch {
    return Response.json({ error: "assistant_failed" }, { status: 502 });
  }
}
