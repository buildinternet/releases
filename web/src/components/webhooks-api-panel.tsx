"use client";

import Link from "next/link";
import type { DeveloperSettingsResponse } from "@buildinternet/releases-api-types";
import { getDeveloperSettings } from "@/lib/me-settings";
import { useSettingsBootstrap } from "@/components/account/use-settings-bootstrap";
import { ApiKeysPanel } from "@/components/api-keys-panel";
import { WebhooksPanel } from "@/components/webhooks-panel";
import { PanelGrid, ErrorText, secondaryButtonClass } from "@releases/design-system";
import { PromoRail } from "@/components/account/promo-rail";

/**
 * Webhooks & API — one-shot bootstrap from GET /v1/me/settings/developer.
 * API keys render only when the bootstrap includes them (feature on).
 */
export function WebhooksApiPanel({
  initial = null,
}: {
  initial?: DeveloperSettingsResponse | null;
}) {
  const { data, status, error, retry } = useSettingsBootstrap(
    initial,
    getDeveloperSettings,
    "Failed to load developer settings.",
  );

  if (status === "loading") {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;
  }

  if (status === "unsigned") {
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

  if (status === "error" || !data) {
    return (
      <div className="space-y-3">
        <ErrorText>{error ?? "Failed to load developer settings."}</ErrorText>
        <button type="button" onClick={() => void retry()} className={secondaryButtonClass}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <PanelGrid aside={<PromoRail />}>
      <div className="flex flex-col gap-9">
        {data.apiKeys != null && (
          <section>
            <div className="mb-3.5 text-sm font-semibold text-stone-900 dark:text-stone-100">
              API keys
            </div>
            <ApiKeysPanel initialKeys={data.apiKeys} />
          </section>
        )}
        <section>
          <WebhooksPanel initialWebhooks={data.webhooks} />
        </section>
      </div>
    </PanelGrid>
  );
}
