import { inArray } from "drizzle-orm";
import { logEvent } from "@releases/lib/log-event";
import type { AnyDb } from "../db.js";
import { user } from "../db/schema-auth.js";

/**
 * Domains where Sentinel's old `emailNormalization` rewrote the stored address
 * (Gmail dots / `googlemail.com`, plus-tags on the providers below). Lookup
 * still treats those spellings as one mailbox so a Google sign-in finds the
 * existing user. Nothing here is written back onto `user.email`.
 */
const PLUS_ADDRESS_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "protonmail.com",
  "proton.me",
  "fastmail.com",
  "zoho.com",
]);

/**
 * Canonical mailbox for alias comparison. Lowercases, maps `googlemail.com` to
 * `gmail.com`, drops a `+tag` on the providers above, and strips dots in a
 * Gmail local part. Other domains come back lowercased and otherwise unchanged,
 * so two different inboxes never compare equal.
 */
export function canonicalMailbox(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return trimmed;
  let local = trimmed.slice(0, at);
  let domain = trimmed.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (PLUS_ADDRESS_DOMAINS.has(domain)) {
    const plus = local.indexOf("+");
    if (plus !== -1) local = local.slice(0, plus);
  }
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return local ? `${local}@${domain}` : trimmed;
}

/**
 * Which stored address a sign-in should bind to.
 *
 * An exact row wins, so an already-split pair stays put (the manual merge
 * decides which row is canonical). Otherwise a Gmail/plus-alias row wins, so
 * `jane.doe@gmail.com` signs into the user who already owns `janedoe@gmail.com`.
 * No match returns the provider address unchanged — a new account keeps the
 * spelling the provider sent.
 */
export function storedEmailForMailbox(providerEmail: string, stored: readonly string[]): string {
  const raw = providerEmail.trim().toLowerCase();
  const exact = stored.find((email) => email.toLowerCase() === raw);
  if (exact) return exact;
  const canon = canonicalMailbox(providerEmail);
  if (canon === raw) return providerEmail;
  const match = stored.find((email) => canonicalMailbox(email) === canon);
  return match ?? providerEmail;
}

let warnedMailboxLookup = false;

function warnMailboxLookup(err: unknown): void {
  if (warnedMailboxLookup) return;
  warnedMailboxLookup = true;
  logEvent("warn", {
    component: "auth",
    event: "mailbox-link-lookup-failed",
    message: "existing-mailbox lookup failed; continuing with the given email",
    error: err instanceof Error ? err.message : String(err),
  });
}

/**
 * Stored `user.email` for this address, or `email` itself when nobody owns that
 * mailbox yet. A lookup failure returns `email` unchanged so sign-in still
 * proceeds. Never throws.
 */
export async function resolveStoredMailbox(db: AnyDb, email: string): Promise<string> {
  const raw = email.trim().toLowerCase();
  if (!raw.includes("@")) return email;
  const canon = canonicalMailbox(email);
  const keys = canon === raw ? [raw] : [raw, canon];
  try {
    const rows = await db
      .select({ email: user.email })
      .from(user)
      .where(inArray(user.email, keys))
      .limit(keys.length);
    return storedEmailForMailbox(
      email,
      rows.map((row) => row.email),
    );
  } catch (err) {
    warnMailboxLookup(err);
    return email;
  }
}

/**
 * Sign-in / sign-up / recovery routes whose body email is a lookup key.
 * `/change-email` is deliberately absent: confirming a new address must not be
 * rewritten onto someone else's row.
 */
const MAILBOX_LINK_PATHS = new Set([
  "/sign-up/email",
  "/sign-in/email",
  "/sign-in/magic-link",
  "/forget-password",
  "/request-password-reset",
  "/send-verification-email",
]);

/**
 * Replacement `body.email` when an existing user already owns this mailbox
 * under a different spelling, or `undefined` when the request should proceed
 * with the address it sent.
 */
export async function alignAuthEmail(
  db: AnyDb,
  path: string,
  body: unknown,
): Promise<string | undefined> {
  if (!MAILBOX_LINK_PATHS.has(path)) return undefined;
  if (!body || typeof body !== "object") return undefined;
  const email = (body as { email?: unknown }).email;
  if (typeof email !== "string" || !email.trim()) return undefined;
  const stored = await resolveStoredMailbox(db, email);
  if (stored.trim().toLowerCase() === email.trim().toLowerCase()) return undefined;
  return stored;
}

/**
 * `user.create.before`: refuse a second row when this address is an alias of
 * an email someone already owns. OAuth linking should have found that user
 * first; this is the backstop for a lookup that still missed. Returning
 * `false` aborts the insert. `undefined` leaves the payload alone.
 */
export async function blockDuplicateMailboxCreate(
  db: AnyDb,
  data: { email?: unknown },
): Promise<false | undefined> {
  if (typeof data.email !== "string" || !data.email.trim()) return undefined;
  const stored = await resolveStoredMailbox(db, data.email);
  if (stored.trim().toLowerCase() === data.email.trim().toLowerCase()) return undefined;
  return false;
}
