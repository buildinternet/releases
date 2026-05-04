import { fromBase64Url, toBase64Url } from "@buildinternet/releases-core/cursor";

export interface CursorValue {
  createdAt: string;
  id: string;
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
