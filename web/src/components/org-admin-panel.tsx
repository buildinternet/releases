"use client";

import { useEffect, useId, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Notice } from "@buildinternet/releases-core/notice";
import {
  setOrgHiddenAction,
  setOrgAutoGenerateContentAction,
  setOrgFeaturedAction,
  setOrgNoticeAction,
  setOrgFetchPausedAction,
  setOrgOverviewCadenceDaysAction,
  renameOrgAction,
} from "@/app/actions/org-admin";
import { NoticeForm } from "@/components/notice-form";
import {
  CADENCE_DEFAULT_HINT,
  CADENCE_MAX,
  CADENCE_MIN,
  clampCadenceDays,
  formatAdminAbsolute,
  formatAdminAge,
  StatusHint,
} from "@/components/entity-admin-shared";
import {
  SettingsSection,
  PanelGrid,
  Aside,
  ListCard,
  ListRow,
  Toggle,
  ErrorText,
  SuccessBanner,
  fieldLabelClass,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@releases/design-system";

export type OrgAdminProductLink = {
  slug: string;
  name: string;
  sourceCount?: number;
};

/**
 * Org admin settings panel. Copy rules: **byline** = public impact of acting;
 * **Status** = last-run / current facts. Product-level settings live on each
 * product’s Admin page — linked from the Products section when multi-product.
 */
export function OrgAdminPanel({
  orgSlug,
  name,
  isHidden,
  autoGenerateContent,
  featured,
  discovery,
  fetchPaused = false,
  notice,
  overviewCadenceDays,
  overviewGeneratedAt = null,
  overviewUpdatedAt = null,
  lastPolledAt = null,
  lastFetchedAt = null,
  products = [],
}: {
  orgSlug: string;
  name: string;
  isHidden: boolean;
  autoGenerateContent: boolean;
  featured: boolean;
  discovery?: string;
  fetchPaused?: boolean;
  notice?: Notice | null;
  overviewCadenceDays?: number | null;
  overviewGeneratedAt?: string | null;
  overviewUpdatedAt?: string | null;
  lastPolledAt?: string | null;
  lastFetchedAt?: string | null;
  /** When length > 1, show per-product admin links (matches public product URLs). */
  products?: OrgAdminProductLink[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [nameDraft, setNameDraft] = useState(name);
  const [cadenceOverride, setCadenceOverride] = useState(overviewCadenceDays != null);
  const [cadenceDays, setCadenceDays] = useState(overviewCadenceDays ?? CADENCE_DEFAULT_HINT);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const displayNameId = useId();
  const cadenceSliderId = useId();
  const cadenceNumberId = useId();

  useEffect(() => {
    setNameDraft(name);
  }, [name]);

  useEffect(() => {
    setCadenceOverride(overviewCadenceDays != null);
    setCadenceDays(overviewCadenceDays ?? CADENCE_DEFAULT_HINT);
  }, [overviewCadenceDays]);

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    startTransition(async () => {
      setError(null);
      setSavedFlash(false);
      try {
        const res = await action();
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setSavedFlash(true);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  const trimmed = nameDraft.trim();
  const canRename = trimmed.length > 0 && trimmed !== name.trim();
  const onDemand = discovery === "on_demand";
  const savedCadence = overviewCadenceDays ?? null;
  const draftCadence = cadenceOverride ? cadenceDays : null;
  const cadenceDirty =
    (draftCadence === null && savedCadence !== null) ||
    (draftCadence !== null && draftCadence !== savedCadence);

  const overviewAge = formatAdminAge(overviewGeneratedAt ?? overviewUpdatedAt);
  const overviewWhen = formatAdminAbsolute(overviewGeneratedAt ?? overviewUpdatedAt);
  const lastPollAge = formatAdminAge(lastPolledAt ?? lastFetchedAt);
  const lastPollWhen = formatAdminAbsolute(lastPolledAt ?? lastFetchedAt);
  // Public product pages only exist when the org has more than one product.
  const productAdminLinks = products.length > 1 ? products : [];

  return (
    <div className="mt-5">
      <SettingsSection
        group="Organization"
        title="Admin"
        description="Curator settings for this organization. Every control’s help text says what changes on the public site — and what does not."
      >
        <PanelGrid
          aside={
            <Aside label="Snapshot">
              <dl className="space-y-2.5 text-[13px] text-stone-600 dark:text-stone-300">
                {(
                  [
                    ["Slug", orgSlug],
                    ["Discovery", discovery ?? "—"],
                    ["Listings", isHidden ? "hidden" : "visible"],
                    ["Featured", featured ? "true" : "false"],
                    ["AI content", autoGenerateContent ? "on" : "off"],
                    ["Fetch", fetchPaused ? "paused" : "active"],
                    [
                      "Cadence",
                      overviewCadenceDays == null ? "default" : `${overviewCadenceDays}d`,
                    ],
                    ["Overview", overviewAge ?? "none"],
                    ["Last poll", lastPollAge ?? "—"],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3">
                    <dt className="text-stone-400 dark:text-stone-500">{label}</dt>
                    <dd
                      className="font-mono text-[12px] text-stone-800 dark:text-stone-200"
                      title={
                        label === "Overview"
                          ? (overviewWhen ?? undefined)
                          : label === "Last poll"
                            ? (lastPollWhen ?? undefined)
                            : undefined
                      }
                    >
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="mt-4 text-[12.5px] leading-relaxed text-stone-500 dark:text-stone-400">
                Snapshot is read-only. Use the controls on the left to change anything — each one
                states its public impact in the byline.
              </p>
            </Aside>
          }
        >
          <div className="flex flex-col gap-9">
            {error && <ErrorText>{error}</ErrorText>}
            {savedFlash && !error && <SuccessBanner>Saved.</SuccessBanner>}

            <section>
              <div className="mb-3.5 text-sm font-semibold text-stone-900 dark:text-stone-100">
                Identity
              </div>
              <p className="mb-3.5 text-[12.5px] leading-relaxed text-stone-500 dark:text-stone-400">
                Changes the name visitors see on this org page, the homepage ticker, catalog, and
                search. The URL slug stays <span className="font-mono">/{orgSlug}</span> — bookmarks
                and links do not break.
              </p>
              <label htmlFor={displayNameId} className={fieldLabelClass}>
                Display name
              </label>
              <input
                id={displayNameId}
                type="text"
                value={nameDraft}
                onChange={(e) => {
                  setNameDraft(e.target.value);
                  setSavedFlash(false);
                  setError(null);
                }}
                className={inputClass}
                autoComplete="off"
              />
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => run(() => renameOrgAction({ slug: orgSlug, name: trimmed }))}
                  disabled={pending || !canRename}
                  className={primaryButtonClass}
                >
                  {pending && canRename ? "Saving…" : "Save name"}
                </button>
                <span className="font-mono text-[12px] text-stone-400 dark:text-stone-500">
                  /{orgSlug}
                </span>
              </div>
            </section>

            <section>
              <div className="mb-3.5 text-sm font-semibold text-stone-900 dark:text-stone-100">
                Visibility
              </div>
              <ListCard>
                <ListRow>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
                      Show in listings
                    </div>
                    <div className="mt-0.5 text-[12.5px] leading-relaxed text-stone-400 dark:text-stone-500">
                      <strong className="font-medium text-stone-500 dark:text-stone-400">
                        On:
                      </strong>{" "}
                      appears in the homepage ticker and the A–Z org directory.{" "}
                      <strong className="font-medium text-stone-500 dark:text-stone-400">
                        Off:
                      </strong>{" "}
                      removed from those surfaces only — direct links, search results, and the
                      sitemap still work.
                    </div>
                  </div>
                  <Toggle
                    label="Show in listings"
                    checked={!isHidden}
                    disabled={pending}
                    onChange={(on) => run(() => setOrgHiddenAction({ slug: orgSlug, hidden: !on }))}
                  />
                </ListRow>
                <ListRow>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
                      Featured on home
                    </div>
                    <div className="mt-0.5 text-[12.5px] leading-relaxed text-stone-400 dark:text-stone-500">
                      <strong className="font-medium text-stone-500 dark:text-stone-400">
                        On:
                      </strong>{" "}
                      shown in the curated org rail on the home page.{" "}
                      <strong className="font-medium text-stone-500 dark:text-stone-400">
                        Off:
                      </strong>{" "}
                      leaves the rail; the full catalog and search are unchanged either way.
                    </div>
                  </div>
                  <Toggle
                    label="Featured on home"
                    checked={featured}
                    disabled={pending}
                    onChange={(on) =>
                      run(() => setOrgFeaturedAction({ slug: orgSlug, featured: on }))
                    }
                  />
                </ListRow>
              </ListCard>
            </section>

            <section>
              <div className="mb-3.5 text-sm font-semibold text-stone-900 dark:text-stone-100">
                Ingest
              </div>
              <ListCard>
                <ListRow>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
                      Pause fetch
                    </div>
                    <div className="mt-0.5 text-[12.5px] leading-relaxed text-stone-400 dark:text-stone-500">
                      <strong className="font-medium text-stone-500 dark:text-stone-400">
                        On:
                      </strong>{" "}
                      the poll loop skips every source under this org — no new releases land until
                      you unpause. Existing releases, the public org page, and URLs stay as they
                      are.{" "}
                      <strong className="font-medium text-stone-500 dark:text-stone-400">
                        Off:
                      </strong>{" "}
                      normal fetch cadence resumes on the next scheduled tick.
                    </div>
                    {lastPollAge && (
                      <StatusHint>
                        Last polled {lastPollAge}
                        {lastPollWhen ? ` (${lastPollWhen})` : ""}.
                      </StatusHint>
                    )}
                  </div>
                  <Toggle
                    label="Pause fetch"
                    checked={fetchPaused}
                    disabled={pending}
                    onChange={(on) =>
                      run(() => setOrgFetchPausedAction({ slug: orgSlug, paused: on }))
                    }
                  />
                </ListRow>
              </ListCard>
            </section>

            <section>
              <div className="mb-3.5 text-sm font-semibold text-stone-900 dark:text-stone-100">
                AI content
              </div>
              <ListCard>
                <ListRow>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
                      Auto-generate content
                    </div>
                    <div className="mt-0.5 text-[12.5px] leading-relaxed text-stone-400 dark:text-stone-500">
                      <strong className="font-medium text-stone-500 dark:text-stone-400">
                        On:
                      </strong>{" "}
                      new releases get AI titles/summaries at ingest, and the Overview tab can
                      regenerate on its cadence.{" "}
                      <strong className="font-medium text-stone-500 dark:text-stone-400">
                        Off:
                      </strong>{" "}
                      stops new generation (existing overview and summaries stay until overwritten).
                      {onDemand
                        ? " On-demand orgs always skip scheduled overview regen; release summaries still follow this toggle."
                        : ""}
                    </div>
                    <StatusHint>
                      {overviewAge
                        ? `Overview last generated ${overviewAge}${overviewWhen ? ` (${overviewWhen})` : ""}.`
                        : "No overview on file yet — enable AI and wait for the next regen, or use a one-shot regenerate when available."}
                    </StatusHint>
                  </div>
                  <Toggle
                    label="Auto-generate content"
                    checked={autoGenerateContent}
                    disabled={pending}
                    onChange={(on) =>
                      run(() => setOrgAutoGenerateContentAction({ slug: orgSlug, enabled: on }))
                    }
                  />
                </ListRow>
                <ListRow className="items-start">
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
                      Overview cadence
                    </div>
                    <div className="mt-0.5 text-[12.5px] leading-relaxed text-stone-400 dark:text-stone-500">
                      Controls how often the Overview tab text is rewritten by the nightly regen
                      job. Does not re-fetch sources or change release history — only the AI
                      narrative on the Overview tab. Default is 7 days (2 days for high-velocity
                      orgs); override with 1–90 days.
                    </div>
                    {overviewAge && (
                      <StatusHint>
                        Current overview is {overviewAge} old
                        {overviewWhen ? ` · generated ${overviewWhen}` : ""}. Next eligible regen
                        follows the cadence below (when AI content is on).
                      </StatusHint>
                    )}

                    <div className="mt-3 flex items-center gap-3">
                      <Toggle
                        label="Custom overview cadence"
                        checked={cadenceOverride}
                        disabled={pending}
                        onChange={(on) => {
                          setCadenceOverride(on);
                          setSavedFlash(false);
                          setError(null);
                          if (!on) {
                            run(() =>
                              setOrgOverviewCadenceDaysAction({ slug: orgSlug, days: null }),
                            );
                          }
                        }}
                      />
                      <span className="text-[12.5px] text-stone-500 dark:text-stone-400">
                        {cadenceOverride
                          ? "Custom interval — Overview rewrites on this schedule"
                          : "System default — 7d (2d when high velocity)"}
                      </span>
                    </div>

                    {cadenceOverride && (
                      <div className="mt-3.5 space-y-3">
                        <div className="flex items-end gap-3">
                          <div className="min-w-0 flex-1">
                            <label htmlFor={cadenceSliderId} className={fieldLabelClass}>
                              Days between regenerations
                            </label>
                            <input
                              id={cadenceSliderId}
                              type="range"
                              min={CADENCE_MIN}
                              max={CADENCE_MAX}
                              step={1}
                              value={cadenceDays}
                              disabled={pending}
                              onChange={(e) => {
                                setCadenceDays(clampCadenceDays(Number(e.target.value)));
                                setSavedFlash(false);
                                setError(null);
                              }}
                              className="h-2 w-full cursor-pointer appearance-none rounded-full bg-stone-200 accent-[var(--accent)] disabled:opacity-50 dark:bg-stone-700"
                            />
                            <div className="mt-1.5 flex justify-between font-mono text-[11px] text-stone-400 dark:text-stone-500">
                              <span>{CADENCE_MIN}d</span>
                              <span>{CADENCE_MAX}d</span>
                            </div>
                          </div>
                          <div className="w-[88px] shrink-0">
                            <label htmlFor={cadenceNumberId} className={fieldLabelClass}>
                              Days
                            </label>
                            <input
                              id={cadenceNumberId}
                              type="number"
                              min={CADENCE_MIN}
                              max={CADENCE_MAX}
                              step={1}
                              value={cadenceDays}
                              disabled={pending}
                              onChange={(e) => {
                                if (e.target.value === "") return;
                                setCadenceDays(clampCadenceDays(Number(e.target.value)));
                                setSavedFlash(false);
                                setError(null);
                              }}
                              className={inputClass}
                            />
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                          <button
                            type="button"
                            onClick={() =>
                              run(() =>
                                setOrgOverviewCadenceDaysAction({
                                  slug: orgSlug,
                                  days: clampCadenceDays(cadenceDays),
                                }),
                              )
                            }
                            disabled={pending || !cadenceDirty}
                            className={primaryButtonClass}
                          >
                            {pending && cadenceDirty ? "Saving…" : "Save cadence"}
                          </button>
                          <span className="text-[12.5px] text-stone-500 dark:text-stone-400">
                            Overview may rewrite every{" "}
                            <span className="font-medium text-stone-700 dark:text-stone-200">
                              {cadenceDays}
                            </span>{" "}
                            day{cadenceDays === 1 ? "" : "s"}
                            {cadenceDirty ? " · unsaved" : ""}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </ListRow>
              </ListCard>
            </section>

            <section>
              <div className="mb-1.5 text-sm font-semibold text-stone-900 dark:text-stone-100">
                Notice
              </div>
              <p className="mb-3.5 text-[12.5px] leading-relaxed text-stone-500 dark:text-stone-400">
                Shows a banner under the org header for every visitor (and a pointer in MCP
                responses). Use for renames, moves, or temporary advisories. Clearing removes the
                banner immediately; it does not change releases or sources. Product-level notices
                are set on each product’s Admin page.
              </p>
              <div className="rounded-xl border border-stone-200 px-4 py-3.5 dark:border-stone-800">
                <NoticeForm
                  embedded
                  notice={notice}
                  pending={pending}
                  onSave={(n) => run(() => setOrgNoticeAction({ slug: orgSlug, notice: n }))}
                  onClear={() => run(() => setOrgNoticeAction({ slug: orgSlug, notice: null }))}
                />
              </div>
              {notice?.message && (
                <StatusHint>
                  Banner is live: “
                  {notice.message.length > 80 ? `${notice.message.slice(0, 80)}…` : notice.message}”
                </StatusHint>
              )}
            </section>

            {productAdminLinks.length > 0 && (
              <section>
                <div className="mb-1.5 text-sm font-semibold text-stone-900 dark:text-stone-100">
                  Products
                </div>
                <p className="mb-3.5 text-[12.5px] leading-relaxed text-stone-500 dark:text-stone-400">
                  Per-product display name and notice. Opening a product Admin does not change
                  org-wide visibility, AI, or fetch settings — those stay on this page.
                </p>
                <ListCard>
                  {productAdminLinks.map((p) => (
                    <ListRow key={p.slug}>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
                          {p.name}
                        </div>
                        <div className="mt-0.5 font-mono text-[12px] text-stone-400 dark:text-stone-500">
                          /{orgSlug}/{p.slug}
                          {p.sourceCount != null ? ` · ${p.sourceCount} sources` : ""}
                        </div>
                      </div>
                      <Link href={`/${orgSlug}/${p.slug}/admin`} className={secondaryButtonClass}>
                        Admin
                      </Link>
                    </ListRow>
                  ))}
                </ListCard>
              </section>
            )}

            <section className="border-t border-stone-200 pt-6 dark:border-stone-800">
              <div className="mb-1.5 text-sm font-semibold text-stone-900 dark:text-stone-100">
                Related
              </div>
              <p className="mb-3 text-[12.5px] leading-relaxed text-stone-500 dark:text-stone-400">
                Jump to other admin-only surfaces for this org. These do not change settings — Fetch
                Log shows recent ingest runs; Playbook is the extraction guidance document.
              </p>
              <div className="flex flex-wrap gap-2">
                <Link href={`/${orgSlug}/fetch-log`} className={secondaryButtonClass}>
                  Fetch Log
                </Link>
                <Link href={`/${orgSlug}/playbook`} className={secondaryButtonClass}>
                  Playbook
                </Link>
              </div>
            </section>
          </div>
        </PanelGrid>
      </SettingsSection>
    </div>
  );
}
