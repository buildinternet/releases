"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useSession, organization } from "@/lib/auth-client";
import { useWorkspaces } from "@/components/account/use-workspaces";
import { WorkspaceAvatar } from "@/components/account/workspace-avatar";
import { PanelGrid } from "@/components/account/settings-section";
import {
  Aside,
  ErrorText,
  SuccessBanner,
  fieldLabelClass,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@/components/account/ui";
import { AvatarUploadButton } from "@/components/avatar-upload-button";
import {
  fetchWorkspaceProfile,
  patchWorkspaceProfile,
  uploadWorkspaceAvatar,
} from "@/lib/account-profile-api";
import type { WorkspaceProfileResponse } from "@buildinternet/releases-api-types";

type ProfileForm = {
  websiteUrl: string;
  changelogUrl: string;
  githubHandle: string;
};

const EMPTY_PROFILE: ProfileForm = { websiteUrl: "", changelogUrl: "", githubHandle: "" };

function profileForm(res: WorkspaceProfileResponse): ProfileForm {
  return {
    websiteUrl: res.profile.websiteUrl ?? "",
    changelogUrl: res.profile.changelogUrl ?? "",
    githubHandle: res.profile.githubHandle ?? "",
  };
}

export function GeneralPanel() {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;
  const { workspaces, active, refetch } = useWorkspaces();
  const current = active ?? workspaces[0] ?? null;

  const [name, setName] = useState("");
  const [logo, setLogo] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileForm>(EMPTY_PROFILE);
  const [savedProfile, setSavedProfile] = useState<ProfileForm>(EMPTY_PROFILE);
  const [profileLoading, setProfileLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const loadProfile = useCallback(async (workspaceId: string) => {
    setProfileLoading(true);
    try {
      const res = await fetchWorkspaceProfile(workspaceId);
      const fields = profileForm(res);
      setLogo(res.logo);
      setProfile(fields);
      setSavedProfile(fields);
    } catch {
      setLogo(null);
      setProfile(EMPTY_PROFILE);
      setSavedProfile(EMPTY_PROFILE);
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    setName(current?.name ?? "");
    if (current?.id) void loadProfile(current.id);
  }, [current?.id, current?.name, loadProfile]);

  if (isPending) return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;

  if (!user) {
    return (
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
        Please{" "}
        <Link href="/login?redirect=/account/general" className="underline">
          sign in
        </Link>{" "}
        to manage your workspace.
      </p>
    );
  }

  if (!current) {
    return (
      <PanelGrid>
        <p className="rounded-xl border border-dashed border-stone-300 px-4 py-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">
          You don't have a workspace yet. Create one from the switcher in the sidebar.
        </p>
      </PanelGrid>
    );
  }

  const nameDirty = name.trim() !== current.name;
  const profileDirty =
    profile.websiteUrl.trim() !== savedProfile.websiteUrl ||
    profile.changelogUrl.trim() !== savedProfile.changelogUrl ||
    profile.githubHandle.trim() !== savedProfile.githubHandle;
  const dirty = nameDirty || profileDirty;

  async function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!current || saving || !dirty) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      if (nameDirty) {
        const res = await organization.update({
          organizationId: current.id,
          data: {
            name: name.trim() || current.name,
          },
        });
        if (res?.error) {
          setError(res.error.message ?? "Could not save the workspace.");
          return;
        }
        await refetch?.();
      }

      if (profileDirty) {
        const profileRes = await patchWorkspaceProfile(current.id, {
          websiteUrl: profile.websiteUrl.trim() || null,
          changelogUrl: profile.changelogUrl.trim() || null,
          githubHandle: profile.githubHandle.trim() || null,
        });
        const fields = profileForm(profileRes);
        setLogo(profileRes.logo);
        setProfile(fields);
        setSavedProfile(fields);
      }

      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the workspace.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <PanelGrid
      aside={
        <Aside label="Workspace">
          <p className="text-[13px] leading-relaxed text-stone-600 dark:text-stone-300">
            These settings apply to{" "}
            <strong className="font-semibold text-stone-900 dark:text-stone-100">everyone</strong>{" "}
            in {current.name} — not just you.
          </p>
        </Aside>
      }
    >
      <form onSubmit={onSave} className="flex flex-col gap-9">
        {error && <ErrorText>{error}</ErrorText>}
        {saved && <SuccessBanner>Workspace saved.</SuccessBanner>}

        <section>
          <div className="mb-3.5 text-sm font-semibold text-stone-900 dark:text-stone-100">
            Workspace avatar
          </div>
          <div className="flex items-center gap-[18px]">
            <span className="flex h-[60px] w-[60px] shrink-0 items-center justify-center overflow-hidden rounded-[14px] bg-[var(--accent)] text-2xl font-semibold text-[var(--on-accent)]">
              <WorkspaceAvatar name={current.name} logo={logo} />
            </span>
            <AvatarUploadButton
              disabled={profileLoading}
              onUpload={async (file) => {
                const res = await uploadWorkspaceAvatar(current.id, file);
                setLogo(res.avatarUrl);
                await refetch?.();
              }}
            />
          </div>
        </section>

        <div className="grid grid-cols-1 gap-x-9 gap-y-9 sm:grid-cols-2">
          <section>
            <label htmlFor="ws-name" className={fieldLabelClass}>
              Workspace name
            </label>
            <input
              id="ws-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(false);
                setError(null);
              }}
              className={inputClass}
            />
          </section>
        </div>

        <section className="grid grid-cols-1 gap-x-9 gap-y-9 sm:grid-cols-2">
          <div>
            <label htmlFor="ws-website" className={fieldLabelClass}>
              Company website
            </label>
            <input
              id="ws-website"
              type="url"
              value={profile.websiteUrl}
              placeholder="https://example.com"
              disabled={profileLoading}
              onChange={(e) => {
                setProfile((p) => ({ ...p, websiteUrl: e.target.value }));
                setSaved(false);
                setError(null);
              }}
              className={inputClass}
            />
          </div>
          <div>
            <label htmlFor="ws-changelog" className={fieldLabelClass}>
              Changelog URL
            </label>
            <input
              id="ws-changelog"
              type="url"
              value={profile.changelogUrl}
              placeholder="https://example.com/changelog"
              disabled={profileLoading}
              onChange={(e) => {
                setProfile((p) => ({ ...p, changelogUrl: e.target.value }));
                setSaved(false);
                setError(null);
              }}
              className={inputClass}
            />
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="ws-github" className={fieldLabelClass}>
              GitHub
            </label>
            <input
              id="ws-github"
              value={profile.githubHandle}
              placeholder="acme or https://github.com/acme"
              disabled={profileLoading}
              onChange={(e) => {
                setProfile((p) => ({ ...p, githubHandle: e.target.value }));
                setSaved(false);
                setError(null);
              }}
              className={inputClass}
            />
            <p className="mt-1.5 text-[12px] text-stone-500 dark:text-stone-400">
              Handle or profile URL — used for links and avatar fallback.
            </p>
          </div>
        </section>

        <section>
          <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">
            Default visibility <span className="font-normal text-stone-400">(coming soon)</span>
          </div>
          <p className="mt-1 mb-3.5 text-[13px] text-stone-500 dark:text-stone-400">
            Applied to new collections created in this workspace.
          </p>
          <div className="flex flex-wrap gap-2.5">
            <span className="flex items-center gap-2.5 rounded-[10px] border border-[var(--accent)] bg-[var(--accent-soft)] px-3.5 py-2.5">
              <span className="h-4 w-4 shrink-0 rounded-full border-[5px] border-[var(--accent)] bg-white" />
              <span>
                <span className="block text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
                  Private
                </span>
                <span className="text-[12px] text-stone-400 dark:text-stone-500">Members only</span>
              </span>
            </span>
            <span className="flex items-center gap-2.5 rounded-[10px] border border-stone-200 px-3.5 py-2.5 opacity-70 dark:border-stone-700">
              <span className="h-4 w-4 shrink-0 rounded-full border-[1.5px] border-stone-300 dark:border-stone-600" />
              <span>
                <span className="block text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
                  Public
                </span>
                <span className="text-[12px] text-stone-400 dark:text-stone-500">
                  Anyone with the link
                </span>
              </span>
            </span>
          </div>
        </section>

        <section className="flex items-center gap-2.5">
          <button
            type="submit"
            disabled={saving || !dirty || profileLoading}
            className={primaryButtonClass}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
          {dirty && (
            <button
              type="button"
              onClick={() => {
                setName(current.name);
                setError(null);
                setSaved(false);
                void loadProfile(current.id);
              }}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
          )}
        </section>
      </form>
    </PanelGrid>
  );
}
