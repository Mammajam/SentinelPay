import { buildOpenApi } from "@/lib/agent/openapi.ts";

/** Public, secret-free tool description. Import this URL (or paste the JSON) into Agent Studio as an OpenAPI tool. */
export async function GET(req: Request) {
  const origin = process.env.PUBLIC_BASE_URL ?? new URL(req.url).origin;
  return Response.json(buildOpenApi(origin), { headers: { "cache-control": "public, max-age=300" } });
}
