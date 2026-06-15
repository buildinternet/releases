"use client";

import { useState } from "react";
import Link from "next/link";
import { useSession, changeEmail } from "@/lib/auth-client";
import { displayEmailOf } from "@/lib/auth-ui";

const labelClass = "block text-sm font-medium text-stone-700 dark:text-stone-200";
const inputClass =
  "mt-1 w-full border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100";
const buttonClass =
  "inline-flex h-10 items-center justify-center border border-stone-300 bg-white px-4 text-sm font-medium text-stone-800 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-900";

export function EmailPanel() {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;

  const [newEmail, setNewEmail] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The address a confirmation link was just sent to (the CURRENT email) — drives
  // the success banner. Cleared whenever the user edits the field again.
  const [confirmSentTo, setConfirmSentTo] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const next = newEmail.trim();
    if (saving || !next || !user) return;
    if (next.toLowerCase() === user.email.toLowerCase()) {
      setError("That's already your email address.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      // Verified accounts (everyone here — sign-in requires verification) get a
      // confirmation link mailed to their CURRENT address; the change only lands
      // once that link is clicked. callbackURL returns them here afterward.
      const res = await changeEmail({
        newEmail: next,
        callbackURL: `${window.location.origin}/account`,
      });
      if (res?.error) {
        setError(res.error.message ?? "Could not change your email. Please try again.");
        return;
      }
      setConfirmSentTo(displayEmailOf(user));
      setNewEmail("");
    } catch {
      setError("Could not change your email. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (isPending) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;
  }

  if (!user) {
    return (
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
        Please{" "}
        <Link href="/login?redirect=/account" className="underline">
          sign in
        </Link>{" "}
        to manage your email.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
          Account
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
          Email
        </h1>
        <p className="mt-3 max-w-prose text-sm leading-6 text-stone-500 dark:text-stone-400">
          Your email address is how you sign in and where account notifications go. Changing it
          sends a confirmation link to your current address — the change takes effect only after you
          click it.
        </p>
      </header>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {confirmSentTo && (
        <div className="border border-green-600/30 bg-green-50 p-4 dark:border-green-500/30 dark:bg-green-950/40">
          <p className="text-sm font-medium text-green-800 dark:text-green-300">
            Confirmation link sent to {confirmSentTo}. Click it to finish changing your email.
          </p>
        </div>
      )}

      <div className="border border-stone-200 p-5 dark:border-stone-800">
        <p className="text-sm text-stone-500 dark:text-stone-400">Current email</p>
        <p className="mt-1 text-sm font-medium text-stone-900 dark:text-stone-100">
          {displayEmailOf(user)}
        </p>
      </div>

      <form
        onSubmit={onSubmit}
        className="space-y-4 border border-stone-200 p-5 dark:border-stone-800"
      >
        <div>
          <label htmlFor="new-email" className={labelClass}>
            New email
          </label>
          <input
            id="new-email"
            type="email"
            autoComplete="email"
            value={newEmail}
            onChange={(e) => {
              setNewEmail(e.target.value);
              setConfirmSentTo(null);
              setError(null);
            }}
            placeholder="you@example.com"
            className={inputClass}
            required
          />
        </div>
        <button type="submit" disabled={saving || !newEmail.trim()} className={buttonClass}>
          {saving ? "Sending…" : "Change email"}
        </button>
      </form>
    </div>
  );
}
