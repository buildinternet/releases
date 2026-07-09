"use client";

import { useEffect, useId, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { Notice } from "@buildinternet/releases-core/notice";
import { renameProductAction, setProductNoticeAction } from "@/app/actions/product-admin";
import { NoticeForm } from "@/components/notice-form";
import { StatusHint } from "@/components/entity-admin-shared";
import {
  SettingsSection,
  PanelGrid,
  Aside,
  ErrorText,
  SuccessBanner,
  fieldLabelClass,
  inputClass,
  primaryButtonClass,
  secondaryButtonClass,
} from "@releases/design-system";

/**
 * Product admin settings surface — same vocabulary as the org Admin tab.
 * Slimmer control set (display name + notice) with a cross-link back to the
 * parent org's admin page.
 */
export function ProductAdminPanel({
  orgSlug,
  orgName,
  productSlug,
  name,
  notice,
  sourceCount = 0,
}: {
  orgSlug: string;
  orgName: string;
  productSlug: string;
  name: string;
  notice?: Notice | null;
  sourceCount?: number;
}) {
  const [error, setError] = useState<string | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const [nameDraft, setNameDraft] = useState(name);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const displayNameId = useId();

  useEffect(() => {
    setNameDraft(name);
  }, [name]);

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
  const productPath = `/${orgSlug}/${productSlug}`;
  const orgAdminPath = `/${orgSlug}/admin`;

  return (
    <div className="mt-5">
      <SettingsSection
        group="Product"
        title="Admin"
        description={
          <>
            Curator settings for this product under{" "}
            <Link
              href={`/${orgSlug}`}
              className="font-medium text-stone-700 underline-offset-2 hover:underline dark:text-stone-200"
            >
              {orgName}
            </Link>
            . Each control’s help text states what changes on the public site — and what does not.
          </>
        }
      >
        <PanelGrid
          aside={
            <Aside label="Snapshot">
              <dl className="space-y-2.5 text-[13px] text-stone-600 dark:text-stone-300">
                <div className="flex justify-between gap-3">
                  <dt className="text-stone-400 dark:text-stone-500">Product</dt>
                  <dd className="font-mono text-[12px] text-stone-800 dark:text-stone-200">
                    {productSlug}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-stone-400 dark:text-stone-500">Org</dt>
                  <dd className="font-mono text-[12px] text-stone-800 dark:text-stone-200">
                    {orgSlug}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-stone-400 dark:text-stone-500">Sources</dt>
                  <dd className="font-mono text-[12px] text-stone-800 dark:text-stone-200">
                    {sourceCount}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-stone-400 dark:text-stone-500">Notice</dt>
                  <dd className="font-mono text-[12px] text-stone-800 dark:text-stone-200">
                    {notice?.message ? "set" : "none"}
                  </dd>
                </div>
              </dl>
              <p className="mt-4 text-[12.5px] leading-relaxed text-stone-500 dark:text-stone-400">
                Org-wide visibility, AI, and fetch controls live on the organization Admin page —
                not here.
              </p>
              <div className="mt-4">
                <Link href={orgAdminPath} className={secondaryButtonClass}>
                  Org Admin
                </Link>
              </div>
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
                Changes the name visitors see on this product page, product lists under the org, and
                search. The URL stays{" "}
                <span className="font-mono">
                  /{orgSlug}/{productSlug}
                </span>{" "}
                — bookmarks and links do not break.
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
                  onClick={() =>
                    run(() => renameProductAction({ orgSlug, productSlug, name: trimmed }))
                  }
                  disabled={pending || !canRename}
                  className={primaryButtonClass}
                >
                  {pending && canRename ? "Saving…" : "Save name"}
                </button>
                <span className="font-mono text-[12px] text-stone-400 dark:text-stone-500">
                  /{orgSlug}/{productSlug}
                </span>
              </div>
            </section>

            <section>
              <div className="mb-1.5 text-sm font-semibold text-stone-900 dark:text-stone-100">
                Notice
              </div>
              <p className="mb-3.5 text-[12.5px] leading-relaxed text-stone-500 dark:text-stone-400">
                Shows a banner under the product header for every visitor (and a pointer in MCP when
                that product is returned). Clearing removes the banner immediately; it does not
                change releases or sources. Org-level notices are separate — set those on{" "}
                <Link
                  href={orgAdminPath}
                  className="font-medium text-stone-600 underline-offset-2 hover:underline dark:text-stone-300"
                >
                  Org Admin
                </Link>
                .
              </p>
              <div className="rounded-xl border border-stone-200 px-4 py-3.5 dark:border-stone-800">
                <NoticeForm
                  embedded
                  notice={notice}
                  pending={pending}
                  onSave={(n) =>
                    run(() => setProductNoticeAction({ orgSlug, productSlug, notice: n }))
                  }
                  onClear={() =>
                    run(() => setProductNoticeAction({ orgSlug, productSlug, notice: null }))
                  }
                />
              </div>
              {notice?.message && (
                <StatusHint>
                  Banner is live: “
                  {notice.message.length > 80 ? `${notice.message.slice(0, 80)}…` : notice.message}”
                </StatusHint>
              )}
            </section>

            <section className="border-t border-stone-200 pt-6 dark:border-stone-800">
              <div className="mb-1.5 text-sm font-semibold text-stone-900 dark:text-stone-100">
                Related
              </div>
              <p className="mb-3 text-[12.5px] leading-relaxed text-stone-500 dark:text-stone-400">
                Jump to the public product page or the parent org’s admin settings (visibility, AI,
                fetch pause, cadence).
              </p>
              <div className="flex flex-wrap gap-2">
                <Link href={productPath} className={secondaryButtonClass}>
                  Product page
                </Link>
                <Link href={orgAdminPath} className={secondaryButtonClass}>
                  Org Admin
                </Link>
              </div>
            </section>
          </div>
        </PanelGrid>
      </SettingsSection>
    </div>
  );
}
