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
    <form onSubmit={submit} className="space-y-3">
      <input className="w-full rounded border px-3 py-2 text-sm" type="password" autoComplete="off" placeholder="Admin API key (sp_adm_…)" value={key} onChange={(e) => setKey(e.target.value)} />
      <input className="w-full rounded border px-3 py-2 text-sm" inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))} />
      {err && <p className="text-sm text-red-700" role="alert">{err}</p>}
      <button disabled={busy || key.length < 10 || totp.length !== 6} className="rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-40">
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

export function LogoutButton() {
  return (
    <button
      className="rounded border px-3 py-1 text-sm"
      onClick={async () => { await fetch("/api/admin/logout", { method: "POST" }); window.location.reload(); }}
    >
      Sign out
    </button>
  );
}
