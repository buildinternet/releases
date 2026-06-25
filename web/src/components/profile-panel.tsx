"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession, updateUser } from "@/lib/auth-client";
import { displayEmailOf } from "@/lib/auth-ui";
import { PanelGrid } from "@/components/account/settings-section";
import {
  Aside,
  ErrorText,
  SuccessBanner,
  fieldLabelClass,
  inputClass,
  textareaClass,
  primaryButtonClass,
  secondaryButtonClass,
  smallButtonClass,
} from "@/components/account/ui";

function ProfileAvatar({
  user,
}: {
  user: { name?: string | null; email: string; image?: string | null };
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [user.image]);
  if (user.image && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={user.image}
        alt=""
        referrerPolicy="no-referrer"
        decoding="async"
        onError={() => setBroken(true)}
        className="h-full w-full object-cover"
      />
    );
  }
  const source = (user.name ?? "").trim() || user.email;
  return <span aria-hidden="true">{source.slice(0, 1).toUpperCase()}</span>;
}

export function ProfilePanel() {
  const { data: sessionData, isPending, refetch } = useSession();
  const user = sessionData?.user;

  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed the editable field once the session resolves / changes.
  useEffect(() => {
    setName(user?.name ?? "");
  }, [user?.name]);

  if (isPending) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;
  }

  if (!user) {
    return (
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
        Please{" "}
        <Link href="/login?redirect=/account/profile" className="underline">
          sign in
        </Link>{" "}
        to view your profile.
      </p>
    );
  }

  const dirty = name.trim() !== (user.name ?? "").trim();

  async function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (saving || !dirty) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await updateUser({ name: name.trim() });
      if (res?.error) {
        setError(res.error.message ?? "Could not save your profile.");
        return;
      }
      setSaved(true);
      await refetch?.();
    } catch {
      setError("Could not save your profile.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <PanelGrid
      aside={
        <Aside label="Profile">
          <p className="text-[13px] leading-relaxed text-stone-600 dark:text-stone-300">
            Your name and avatar are how you appear in Releases — in workspaces you belong to and on
            your own feed.
          </p>
        </Aside>
      }
    >
      <form onSubmit={onSave} className="flex flex-col gap-9">
        {error && <ErrorText>{error}</ErrorText>}
        {saved && <SuccessBanner>Profile saved.</SuccessBanner>}

        <section>
          <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">
            Profile photo
          </div>
          <p className="mt-1 mb-4 text-[13px] text-stone-500 dark:text-stone-400">
            Synced from your sign-in provider. Custom uploads are coming soon.
          </p>
          <div className="flex items-center gap-[18px]">
            <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--accent)] text-2xl font-semibold text-[var(--on-accent)]">
              <ProfileAvatar user={user} />
            </span>
            <button
              type="button"
              disabled
              title="Avatar upload is coming soon"
              className={smallButtonClass}
            >
              Upload
            </button>
          </div>
        </section>

        <div className="grid grid-cols-1 gap-x-9 gap-y-9 sm:grid-cols-2">
          <section>
            <label htmlFor="display-name" className={fieldLabelClass}>
              Display name
            </label>
            <input
              id="display-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(false);
                setError(null);
              }}
              className={inputClass}
              placeholder="Your name"
            />
          </section>
        </div>

        <section>
          <label htmlFor="bio" className={fieldLabelClass}>
            Bio <span className="font-normal text-stone-400">(coming soon)</span>
          </label>
          <textarea
            id="bio"
            rows={3}
            disabled
            placeholder="Tell people what you track."
            className={textareaClass}
          />
        </section>

        <section className="flex items-center gap-2.5">
          <button type="submit" disabled={saving || !dirty} className={primaryButtonClass}>
            {saving ? "Saving…" : "Save changes"}
          </button>
          {dirty && (
            <button
              type="button"
              onClick={() => {
                setName(user.name ?? "");
                setError(null);
                setSaved(false);
              }}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
          )}
        </section>

        <section>
          <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">Email</div>
          <p className="mt-1 text-[13px] text-stone-500 dark:text-stone-400">
            {displayEmailOf(user)}
          </p>
          <Link
            href="/account/security"
            className="mt-2 inline-block text-[13px] text-[var(--accent)]"
          >
            Manage in Security
          </Link>
        </section>
      </form>
    </PanelGrid>
  );
}
