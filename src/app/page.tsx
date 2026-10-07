import { Suspense } from "react";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { hasDb } from "@/lib/db/client.ts";
import { tenantName } from "@/lib/db/store.ts";
import { verifyStoredChain } from "@/lib/db/audit.ts";
import { verifyAnchors } from "@/lib/db/anchor.ts";
import { readSession, SESSION_COOKIE } from "@/lib/auth/session.ts";
import { LoginForm, LogoutButton } from "./auth-forms.tsx";
import { DashboardClient } from "./dashboard-client.tsx";

async function Dashboard() {
  // Per-request only: never prerender or cache tenant data (also keeps `new Date()` in readSession legal).
  await connection();
  const jar = await cookies();
  let session = null;
  try { session = readSession(jar.get(SESSION_COOKIE)?.value); } catch { /* SESSION_SECRET missing => treated as logged out */ }

  if (!session) {
    return (
      <main className="mx-auto max-w-md p-8">
        <h1 className="text-2xl font-semibold">SentinelPay</h1>
        <p className="mb-6 text-sm text-neutral-600">Operator sign-in. Admin API key + one-time code from your authenticator app.</p>
        <LoginForm />
      </main>
    );
  }

  let name: string | null = null;
  let chain: number | null | "unavailable" = "unavailable";
  let anchors: Awaited<ReturnType<typeof verifyAnchors>> | null = null;
  if (hasDb()) {
    try {
      [name, chain, anchors] = await Promise.all([tenantName(session.tenantId), verifyStoredChain(), verifyAnchors()]);
    } catch { /* render degraded view */ }
  }

  return (
    <main className="mx-auto max-w-5xl p-8">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">SentinelPay</h1>
          <p className="text-sm text-neutral-600">Tenant: <b>{name ?? session.tenantId}</b></p>
        </div>
        <LogoutButton />
      </div>

      <p className="mt-4 text-sm">
        Audit chain:{" "}
        {chain === "unavailable" ? <b>database not connected</b> : chain === null ? <b className="text-emerald-700">intact</b> : <b className="text-red-700">BROKEN at #{chain}</b>}
        {" · "}Anchors:{" "}
        {!anchors ? <b>unavailable</b> : anchors.checked === 0 ? <b className="text-amber-700">none yet</b> : anchors.mismatched.length ? <b className="text-red-700">MISMATCH at #{anchors.mismatched.join(", #")}</b> : <b className="text-emerald-700">{anchors.checked} verified ({anchors.lastSink})</b>}
      </p>

      <DashboardClient />
      <p className="mt-6 text-xs text-neutral-500">Read-only session (30 min). Only your tenant&apos;s data is shown.</p>
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
