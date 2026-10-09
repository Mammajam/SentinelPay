/** Liveness: the process is up. No dependencies, so a database outage never restarts healthy instances. */
export async function GET() {
  return Response.json({ ok: true });
}
