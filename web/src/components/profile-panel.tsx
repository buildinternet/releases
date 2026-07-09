"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession, updateUser } from "@/lib/auth-client";
import { displayEmailOf } from "@/lib/auth-ui";
import {
  PanelGrid,
  Aside,
  ErrorText,
  SuccessBanner,
  fieldLabelClass,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@releases/design-system";
import { AvatarUploadButton } from "@/components/avatar-upload-button";
import { uploadUserAvatar } from "@/lib/account-profile-api";
import { UserAvatar } from "@/components/account/user-avatar";
import {
  readUserDisplayCache,
  writeUserDisplayCache,
  type CachedUserDisplay,
} from "@/components/account/user-display-cache";

export function ProfilePanel() {
  const { data: sessionData, isPending, refetch } = useSession();
  const user = sessionData?.user;
  const [cached, setCached] = useState<CachedUserDisplay | null>(() => readUserDisplayCache());

  const [name, setName] = useState(() => readUserDisplayCache()?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed the editable field once the session resolves / changes.
  useEffect(() => {
    if (user?.name != null) setName(user.name);
  }, [user?.name]);

  useEffect(() => {
    if (!user) return;
    const next: CachedUserDisplay = {
      id: user.id,
      name: user.name ?? null,
      email: user.email,
      image: user.image ?? null,
    };
    writeUserDisplayCache(next);
    setCached(next);
  }, [user?.id, user?.name, user?.email, user?.image]);

  // Prefer live session; fall back to last-known display while session is pending.
  const displayUser = user ?? (isPending ? cached : null);

  if (isPending && !displayUser) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;
  }

  if (!displayUser) {
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

  const baselineName = (user?.name ?? displayUser.name ?? "").trim();
  const dirty = name.trim() !== baselineName;
  const sessionReady = Boolean(user);

  async function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!sessionReady || saving || !dirty) return;
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
            Upload a square image (PNG, JPEG, GIF, or WebP, at least 128×128). Provider avatars
            still apply until you upload your own.
          </p>
          <div className="flex items-center gap-[18px]">
            <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[var(--accent)] text-2xl font-semibold text-[var(--on-accent)]">
              <UserAvatar user={displayUser} />
            </span>
            <AvatarUploadButton
              disabled={!sessionReady}
              onUpload={async (file) => {
                await uploadUserAvatar(file);
                await refetch?.();
              }}
            />
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
              disabled={!sessionReady}
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

        <section className="flex items-center gap-2.5">
          <button
            type="submit"
            disabled={!sessionReady || saving || !dirty}
            className={primaryButtonClass}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
          {dirty && sessionReady && (
            <button
              type="button"
              onClick={() => {
                setName(user?.name ?? displayUser.name ?? "");
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
            {displayEmailOf(displayUser)}
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
