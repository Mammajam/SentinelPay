/**
 * Persist a grid's column layout (order, width, visibility, sort) per operator browser.
 * Pure + storage-injected so it is unit-tested; EVERY storage touch is wrapped: private windows, blocked
 * site data and corrupted values must degrade to "no saved layout", never break the dashboard.
 */
export interface SavedColumn { colId: string; width?: number; hide?: boolean; sort?: "asc" | "desc" | null; sortIndex?: number | null }

/** Default sort applied only when the operator has no saved layout (and again on Reset layout). */
export interface DefaultSort { colId: string; sort: "asc" | "desc" }

export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

const PREFIX = "sentinelpay:grid:";
const MAX_COLUMNS = 40;
const MAX_BYTES = 8_000;

/** Keep only the known, well-typed fields of each column; drop anything else (defence against tampered storage). */
export function sanitizeState(input: unknown): SavedColumn[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_COLUMNS) return null;
  const out: SavedColumn[] = [];
  for (const c of input) {
    if (!c || typeof c !== "object" || typeof (c as SavedColumn).colId !== "string" || (c as SavedColumn).colId.length > 100) return null;
    const { colId, width, hide, sort, sortIndex } = c as SavedColumn;
    out.push({
      colId,
      ...(typeof width === "number" && Number.isFinite(width) && width > 0 && width < 5000 ? { width } : {}),
      ...(typeof hide === "boolean" ? { hide } : {}),
      ...(sort === "asc" || sort === "desc" || sort === null ? { sort } : {}),
      ...(typeof sortIndex === "number" || sortIndex === null ? { sortIndex } : {}),
    });
  }
  return out;
}

export function loadState(key: string, storage: StorageLike | undefined): SavedColumn[] | null {
  try {
    const raw = storage?.getItem(PREFIX + key);
    if (!raw || raw.length > MAX_BYTES) return null;
    return sanitizeState(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveState(key: string, state: unknown, storage: StorageLike | undefined): boolean {
  try {
    const clean = sanitizeState(state);
    if (!clean || !storage) return false;
    const raw = JSON.stringify(clean);
    if (raw.length > MAX_BYTES) return false;
    storage.setItem(PREFIX + key, raw);
    return true;
  } catch {
    return false;
  }
}

export function clearState(key: string, storage: StorageLike | undefined): void {
  try { storage?.removeItem(PREFIX + key); } catch { /* nothing to do */ }
}
