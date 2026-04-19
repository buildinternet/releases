export interface CursorValue {
  createdAt: string;
  id: string;
}

function toBase64Url(s: string): string {
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string | null {
  try {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    return atob(padded + pad);
  } catch {
    return null;
  }
}

export function encodeCursor(v: CursorValue): string {
  return toBase64Url(`${v.createdAt}|${v.id}`);
}

export function decodeCursor(token: string): CursorValue | null {
  if (!token) return null;
  const raw = fromBase64Url(token);
  if (!raw) return null;
  const sep = raw.indexOf("|");
  if (sep <= 0 || sep === raw.length - 1) return null;
  const createdAt = raw.slice(0, sep);
  const id = raw.slice(sep + 1);
  if (!createdAt || !id) return null;
  return { createdAt, id };
}
