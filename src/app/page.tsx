import { Suspense } from "react";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { hasDb } from "@/lib/db/client.ts";
import { tenantName } from "@/lib/db/store.ts";
import { verifyStoredChain } from "@/lib/db/audit.ts";
import { verifyAnchors } from "@/lib/db/anchor.ts";
import { readSession, SESSION_COOKIE } from "@/lib/auth/session.ts";
import { LoginForm, LogoutButton } from "./auth-forms.tsx";
import { Logo } from "./brand.tsx";
import { DashboardClient } from "./dashboard-client.tsx";

async function Dashboard() {
  // Per-request only: never prerender or cache tenant data (also keeps `new Date()` in readSession legal).
  await connection();
  const jar = await cookies();
  let session = null;
  try { session = readSession(jar.get(SESSION_COOKIE)?.value); } catch { /* SESSION_SECRET missing => treated as logged out */ }

  if (!session) {
    return (
      <main className="grid min-h-screen lg:grid-cols-2">
        <section className="relative hidden flex-col justify-between overflow-hidden bg-gradient-to-br from-brand-deep via-brand-navy to-brand-sky p-12 text-white lg:flex">
          <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-white/10 blur-3xl" />
          <div className="pointer-events-none absolute -bottom-32 -left-16 h-96 w-96 rounded-full bg-cta/20 blur-3xl" />
          <div className="relative flex items-center gap-3"><Logo size={44} /><span className="text-2xl font-semibold tracking-tight">SentinelPay</span></div>
          <div className="relative max-w-md">
            <h1 className="text-4xl font-semibold leading-tight tracking-tight">Guardrails for agentic commerce.</h1>
            <p className="mt-4 text-white/80">Every cart an AI agent builds is checked against your policy before PayPal ever sees it.</p>
            <ul className="mt-8 space-y-4 text-sm">
              {[
                ["Policy-checked carts", "ALLOW, REQUIRE_REAUTH or DENY on every order, before capture."],
                ["Tamper-evident audit", "Hash-chained entries with external anchors you can verify."],
                ["Verified against PayPal", "Captures are reconciled with PayPal's own breakdown."],
              ].map(([t, d]) => (
                <li key={t} className="flex gap-3">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-cta text-xs font-bold text-cta-ink" aria-hidden="true">✓</span>
                  <span><b className="block font-semibold">{t}</b><span className="text-white/75">{d}</span></span>
                </li>
              ))}
            </ul>
          </div>
          <p className="relative text-xs text-white/60">Operator console · read-only sessions</p>
        </section>
        <section className="flex items-center justify-center p-6 sm:p-12">
          <div className="sp-card w-full max-w-md p-8">
            <div className="mb-6 flex items-center gap-3 lg:hidden"><Logo /><span className="text-xl font-semibold text-brand-navy dark:text-foreground">SentinelPay</span></div>
            <h2 className="text-2xl font-semibold tracking-tight">Operator sign-in</h2>
            <p className="sp-muted mb-6 mt-1 text-sm">Use your admin API key and the one-time code from your authenticator app.</p>
            <LoginForm />
          </div>
        </section>
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

  const chainStatus =
    chain === "unavailable" ? { tone: "warn", label: "Not connected", detail: "Database not connected" }
    : chain === null ? { tone: "ok", label: "Intact", detail: "Every entry re-hashes and links to the one before it" }
    : { tone: "bad", label: "Broken", detail: `Chain breaks at entry #${chain}` };
  const anchorStatus =
    !anchors ? { tone: "warn", label: "Unavailable", detail: "Anchors could not be checked" }
    : anchors.checked === 0 ? { tone: "warn", label: "None yet", detail: "No anchors written so far" }
    : anchors.mismatched.length ? { tone: "bad", label: "Mismatch", detail: `Mismatch at #${anchors.mismatched.join(", #")}` }
    : { tone: "ok", label: "Verified", detail: `${anchors.checked} checked (${anchors.lastSink})` };

  return (
    <>
      <header className="sticky top-0 z-20 bg-brand-navy text-white shadow-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-8">
          <div className="flex items-center gap-3"><Logo size={32} /><span className="text-lg font-semibold tracking-tight">SentinelPay</span></div>
          <div className="flex items-center gap-3">
            <span className="hidden rounded-full bg-white/10 px-3 py-1 text-sm sm:inline">Tenant: <b>{name ?? session.tenantId}</b></span>
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-8">
        <div className="grid gap-4 sm:grid-cols-2">
          <StatusCard title="Audit chain" {...chainStatus} />
          <StatusCard title="External anchors" {...anchorStatus} />
        </div>
        <DashboardClient />
        <p className="sp-muted mt-8 text-xs">Read-only session (30 min). Only your tenant&apos;s data is shown.</p>
      </main>
    </>
  );
}

function StatusCard({ title, tone, label, detail }: { title: string; tone: string; label: string; detail: string }) {
  return (
    <div className="sp-card flex items-center justify-between gap-4 p-4">
      <div>
        <p className="sp-muted text-xs font-medium uppercase tracking-wide">{title}</p>
        <p className="mt-1 text-sm">{detail}</p>
      </div>
      <span className={`sp-badge sp-badge-${tone} shrink-0`}>{label}</span>
    </div>
  );
}

export default function Home() {
  return (
    <Suspense fallback={<main className="p-8 text-sm">Loading…</main>}>
      <Dashboard />
    </Suspense>
  );
}
