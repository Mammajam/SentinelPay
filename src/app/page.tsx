import { Suspense } from "react";
import { connection } from "next/server";
import { hasDb } from "@/lib/db/client.ts";
import { recentValidations } from "@/lib/db/store.ts";
import { verifyStoredChain } from "@/lib/db/audit.ts";


const tone: Record<string, string> = {
  ALLOW: "text-emerald-700 bg-emerald-50",
  REQUIRE_REAUTH: "text-amber-700 bg-amber-50",
  DENY: "text-red-700 bg-red-50",
};

async function Dashboard() {
  await connection(); // per-request data
  let rows: Awaited<ReturnType<typeof recentValidations>> = [];
  let chain: number | null | "unavailable" = "unavailable";
  if (hasDb()) {
    try {
      [rows, chain] = await Promise.all([recentValidations(), verifyStoredChain()]);
    } catch { /* render degraded view */ }
  }

  return (
    <main className="mx-auto max-w-5xl p-8">
      <h1 className="text-2xl font-semibold">SentinelPay</h1>
      <p className="text-sm text-neutral-600">Guardrail &amp; verification proxy for agentic commerce</p>

      <p className="mt-4 text-sm">
        Audit chain:{" "}
        {chain === "unavailable" ? <b>database not connected</b> : chain === null ? <b className="text-emerald-700">intact</b> : <b className="text-red-700">BROKEN at #{chain}</b>}
      </p>

      <h2 className="mt-8 mb-2 font-medium">Recent cart validations</h2>
      <table className="w-full text-sm">
        <thead><tr className="text-left text-neutral-500"><th>#</th><th>Cart</th><th>Decision</th><th>Violations</th><th>When</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t">
              <td>{r.id}</td><td>{r.cartId}</td>
              <td><span className={`rounded px-2 py-0.5 ${tone[r.decision] ?? ""}`}>{r.decision}</span></td>
              <td>{(r.violations as { code: string }[]).map((v) => v.code).join(", ") || "—"}</td>
              <td>{new Date(r.at).toLocaleString()}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="py-6 text-neutral-500">No validations yet.</td></tr>}
        </tbody>
      </table>
      <p className="mt-6 text-xs text-neutral-500">Dashboard is read-only in this slice. AG Grid Enterprise is deferred to Phase 4 (licensing + vertical-slice-first).</p>
    </main>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<main className="p-8 text-sm">Loading…</main>}>
      <Dashboard />
    </Suspense>
  );
}
