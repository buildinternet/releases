"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { WebhooksIcon } from "@/components/account/icons";
import { orgWebhookCreatePath, orgWorkspaceWebhookCreatePath } from "@/lib/webhook-create";
import { MoreIcon } from "./icons";

/**
 * Quiet org-header overflow (⋯), matching the Copy-for-agent menu chrome.
 * Holds uncommon actions so they don't compete with Follow. Callers hide this
 * when auth isn't wired (`AUTH_CONFIGURED`) — `/account/webhooks` 404s then.
 */
export function AddOrgWebhookLink({ orgSlug, orgName }: { orgSlug: string; orgName?: string }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-9 w-9 items-center justify-center rounded-full text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700 dark:text-stone-500 dark:hover:bg-stone-800/60 dark:hover:text-stone-200"
      >
        <MoreIcon className="h-[18px] w-[18px]" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} aria-hidden="true" />
          <div
            role="menu"
            className="account-menu-pop absolute right-0 top-full z-40 mt-1.5 w-[240px] rounded-xl border border-[var(--line)] bg-[var(--surface)] p-1.5 shadow-[0_16px_40px_-14px_rgba(0,0,0,0.35)]"
          >
            <AddOrgWebhookMenuItem orgSlug={orgSlug} orgName={orgName} />
            <AddOrgWorkspaceWebhookMenuItem orgSlug={orgSlug} orgName={orgName} />
          </div>
        </>
      )}
    </div>
  );
}

/** Shared menu-row markup for both webhook create deep-links below. */
function WebhookMenuItem({
  href,
  ariaLabel,
  title,
  subtitle,
}: {
  href: string;
  ariaLabel: string;
  title: string;
  subtitle: string;
}) {
  return (
    <Link
      role="menuitem"
      href={href}
      aria-label={ariaLabel}
      className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--surface-2)]"
    >
      <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-[var(--surface-2)] text-[var(--fg-2)]">
        <WebhooksIcon className="h-[15px] w-[15px]" />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-[var(--fg)]">{title}</span>
        <span className="block truncate text-[11.5px] text-[var(--fg-3)]">{subtitle}</span>
      </span>
    </Link>
  );
}

/** Menu row — extracted so tests can assert the deep-link without opening state. */
export function AddOrgWebhookMenuItem({ orgSlug, orgName }: { orgSlug: string; orgName?: string }) {
  return (
    <WebhookMenuItem
      href={orgWebhookCreatePath(orgSlug)}
      ariaLabel={orgName ? `Add webhook for me — ${orgName}` : "Add webhook for me"}
      title="Add webhook for me"
      subtitle="Only you see this one"
    />
  );
}

/** Menu row deep-linking to the workspace webhooks page (#2324), scoped to this org. */
export function AddOrgWorkspaceWebhookMenuItem({
  orgSlug,
  orgName,
}: {
  orgSlug: string;
  orgName?: string;
}) {
  return (
    <WebhookMenuItem
      href={orgWorkspaceWebhookCreatePath(orgSlug)}
      ariaLabel={
        orgName ? `Add webhook for this workspace — ${orgName}` : "Add webhook for this workspace"
      }
      title="Add webhook for this workspace"
      subtitle="Everyone in the workspace sees this one"
    />
  );
}
