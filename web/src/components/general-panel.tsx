"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession, organization } from "@/lib/auth-client";
import { toSlug } from "@buildinternet/releases-core/slug";
import { useWorkspaces, workspaceInitial } from "@/components/account/use-workspaces";
import { PanelGrid } from "@/components/account/settings-section";
import {
  Aside,
  ErrorText,
  SuccessBanner,
  fieldLabelClass,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
  smallButtonClass,
} from "@/components/account/ui";

export function GeneralPanel() {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;
  const { workspaces, active, refetch } = useWorkspaces();
  const current = active ?? workspaces[0] ?? null;

  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setName(current?.name ?? "");
    setSlug(current?.slug ?? "");
  }, [current?.name, current?.slug]);

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

  const nextSlug = toSlug(slug).slice(0, 48);
  const dirty = name.trim() !== current.name || (nextSlug && nextSlug !== current.slug);

  async function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!current || saving || !dirty) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await organization.update({
        organizationId: current.id,
        data: {
          name: name.trim() || current.name,
          ...(nextSlug && nextSlug !== current.slug ? { slug: nextSlug } : {}),
        },
      });
      if (res?.error) {
        setError(res.error.message ?? "Could not save the workspace.");
        return;
      }
      setSaved(true);
      await refetch?.();
    } catch {
      setError("Could not save the workspace.");
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
          <p className="mt-2.5 text-[13px] leading-relaxed text-stone-600 dark:text-stone-300">
            Changing the URL updates every shared link.
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
            <span className="flex h-[60px] w-[60px] shrink-0 items-center justify-center rounded-[14px] bg-[var(--accent)] text-2xl font-semibold text-[var(--on-accent)]">
              {workspaceInitial(current.name)}
            </span>
            <button
              type="button"
              disabled
              title="Workspace avatar upload is coming soon"
              className={smallButtonClass}
            >
              Upload
            </button>
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

          <section>
            <label htmlFor="ws-slug" className={fieldLabelClass}>
              Workspace URL
            </label>
            <div className="flex h-10 items-center overflow-hidden rounded-[9px] border border-stone-200 bg-white focus-within:border-[var(--accent)] dark:border-stone-700 dark:bg-stone-950">
              <span className="pl-3 font-mono text-sm text-stone-400 dark:text-stone-500">
                releases.sh/
              </span>
              <input
                id="ws-slug"
                value={slug}
                onChange={(e) => {
                  setSlug(e.target.value);
                  setSaved(false);
                  setError(null);
                }}
                className="h-full min-w-0 flex-1 border-none bg-transparent px-0 font-mono text-sm text-stone-900 outline-none dark:text-stone-100"
              />
            </div>
          </section>
        </div>

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
          <button type="submit" disabled={saving || !dirty} className={primaryButtonClass}>
            {saving ? "Saving…" : "Save changes"}
          </button>
          {dirty && (
            <button
              type="button"
              onClick={() => {
                setName(current.name);
                setSlug(current.slug);
                setError(null);
                setSaved(false);
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
