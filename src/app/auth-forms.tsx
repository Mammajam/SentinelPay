"use client";

import { useState } from "react";

export function LoginForm() {
  const [key, setKey] = useState("");
  const [totp, setTotp] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, totp }),
    });
    setBusy(false);
    if (res.ok) { window.location.reload(); return; }
    setErr(res.status === 429 ? "Too many attempts. Try again later." : "Sign-in failed.");
    setTotp("");
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <label className="block text-sm font-medium">Admin API key
        <input className="sp-input mt-1 w-full" type="password" autoComplete="off" placeholder="sp_adm_…" value={key} onChange={(e) => setKey(e.target.value)} />
      </label>
      <label className="block text-sm font-medium">One-time code
        <input className="sp-input mt-1 w-full text-center font-mono text-lg tracking-[0.5em]" inputMode="numeric" autoComplete="one-time-code" placeholder="••••••" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))} />
      </label>
      {err && <p className="rounded-lg px-3 py-2 text-sm sp-badge-bad" role="alert">{err}</p>}
      <button disabled={busy || key.length < 10 || totp.length !== 6} className="sp-btn sp-btn-cta sp-btn-lg">
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export function LogoutButton() {
  return (
    <button
      className="rounded-full border border-white/40 bg-white/10 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
      onClick={async () => { await fetch("/api/admin/logout", { method: "POST" }); window.location.reload(); }}
    >
      Sign out
    </button>
  );
}
