/**
 * Last-known user display fields for account chrome (avatar / name) so Profile
 * and the header can paint a stable photo before useSession resolves.
 * Client-only; no secrets.
 */

export type CachedUserDisplay = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
};

const USER_DISPLAY_CACHE_KEY = "releases.user_display";

export function readUserDisplayCache(): CachedUserDisplay | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(USER_DISPLAY_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedUserDisplay>;
    if (typeof parsed.id !== "string" || typeof parsed.email !== "string") return null;
    return {
      id: parsed.id,
      name: typeof parsed.name === "string" ? parsed.name : null,
      email: parsed.email,
      image: typeof parsed.image === "string" ? parsed.image : null,
    };
  } catch {
    return null;
  }
}

export function writeUserDisplayCache(user: CachedUserDisplay | null): void {
  if (typeof window === "undefined") return;
  try {
    if (!user) {
      localStorage.removeItem(USER_DISPLAY_CACHE_KEY);
      return;
    }
    localStorage.setItem(USER_DISPLAY_CACHE_KEY, JSON.stringify(user));
  } catch {
    // Quota / private mode — ignore.
  }
}
