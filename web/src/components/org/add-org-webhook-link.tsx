import Link from "next/link";
import { orgWebhookCreatePath } from "@/lib/webhook-create";

/**
 * Secondary org-header action: deep-link to Account → Webhooks & API with
 * Org scope + this org already filled in. Callers hide this when auth isn't
 * wired (`AUTH_CONFIGURED`) — `/account/webhooks` 404s in that environment.
 */
export function AddOrgWebhookLink({ orgSlug, orgName }: { orgSlug: string; orgName?: string }) {
  return (
    <Link
      href={orgWebhookCreatePath(orgSlug)}
      className="inline-flex min-h-9 items-center justify-center rounded-full border border-stone-300 px-4 text-sm font-bold text-stone-600 transition-[color,background-color,border-color] hover:bg-stone-50 dark:border-stone-600 dark:text-stone-200 dark:hover:bg-stone-800"
      aria-label={orgName ? `Add webhook for ${orgName}` : "Add webhook"}
    >
      Add webhook
    </Link>
  );
}
