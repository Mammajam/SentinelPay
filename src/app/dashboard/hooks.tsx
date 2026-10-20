"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";

// Client-only: AG Grid has no meaningful server render, and skipping it avoids a light-themed flash before hydration.
export const DataGrid = dynamic(() => import("../data-grid.tsx"), {
  ssr: false,
  loading: () => <p className="py-6 text-sm text-neutral-500">Loading grid…</p>,
}) as typeof import("../data-grid.tsx").default;

export async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (r.status === 401) { window.location.reload(); throw new Error("session expired"); }
  if (!r.ok) throw new Error(`request failed (${r.status})`);
  return (await r.json()) as T;
}

/** Fetch-on-mount/update. State is set only inside promise callbacks (never synchronously in the effect). */
export function useApi<T>(url: string, tick = 0) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  useEffect(() => {
    let cancelled = false;
    getJson<T>(url).then(
      (data) => { if (!cancelled) setState({ data }); },
      (e: Error) => { if (!cancelled) setState({ error: e.message }); },
    );
    return () => { cancelled = true; };
  }, [url, tick]);
  return state;
}

/** Asks for the admin key + one-time code at the moment of a sensitive action; never stores them. */
export function SecureAction({ label, busy, onSubmit, onCancel }: { label: string; busy: boolean; onSubmit: (key: string, totp: string) => void; onCancel: () => void }) {
  const [key, setKey] = useState("");
  const [totp, setTotp] = useState("");
  return (
    <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); onSubmit(key, totp); setKey(""); setTotp(""); }}>
      <input className="w-64 rounded border px-2 py-1 text-xs" type="password" autoComplete="off" placeholder="Admin API key" value={key} onChange={(e) => setKey(e.target.value)} />
      <input className="w-28 rounded border px-2 py-1 text-xs" inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ""))} />
      <button disabled={busy || key.length < 10 || totp.length !== 6} className="rounded bg-black px-3 py-1 text-xs text-white disabled:opacity-40">{busy ? "Working…" : label}</button>
      <button type="button" onClick={onCancel} className="text-xs underline">Cancel</button>
    </form>
  );
}

/** Small coloured pill used in cells. `kind` maps to the .sp-badge-* classes in globals.css. */
export const badge = (kind: string, text: string) => <span className={`sp-badge sp-badge-${kind}`}>{text}</span>;
