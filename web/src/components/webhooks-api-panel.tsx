"use client";

import Link from "next/link";
import { useSession } from "@/lib/auth-client";
import { USER_API_KEYS_ENABLED } from "@/lib/auth-ui";
import { ApiKeysPanel } from "@/components/api-keys-panel";
import { WebhooksPanel } from "@/components/webhooks-panel";
import { PanelGrid } from "@/components/account/settings-section";
import { PromoRail } from "@/components/account/promo-rail";

/**
 * Workspace "Webhooks & API" panel — composes the existing (fully-wired) API
 * keys and webhook-endpoint surfaces into the redesigned two-column layout with
 * the MCP/CLI promo rail. API keys stay gated on {@link USER_API_KEYS_ENABLED},
 * matching the standalone route's gate.
 */
export function WebhooksApiPanel() {
  const { data, isPending } = useSession();
  const user = data?.user;

  if (isPending) return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;

  if (!user) {
    return (
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
        Please{" "}
        <Link href="/login?redirect=/account/webhooks" className="underline">
          sign in
        </Link>{" "}
        to manage programmatic access.
      </p>
    );
  }

  return (
    <PanelGrid aside={<PromoRail />}>
      <div className="flex flex-col gap-9">
        {USER_API_KEYS_ENABLED && (
          <section>
            <div className="mb-3.5 text-sm font-semibold text-stone-900 dark:text-stone-100">
              API keys
            </div>
            <ApiKeysPanel />
          </section>
        )}
        <section>
          <WebhooksPanel />
        </section>
      </div>
    </PanelGrid>
  );
}
