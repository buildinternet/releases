import {
  PanelGrid,
  PreviewBanner,
  cardClass,
  listCardClass,
  listRowClass,
  smallButtonClass,
  smallPrimaryButtonClass,
} from "@releases/design-system";
import { CardIcon, BillingIcon } from "@/components/account/icons";

/**
 * Workspace "Billing" — preview/static. Stripe is wired only as an inert
 * customer-registration seam (no subscriptions yet), so this is a faithful
 * mockup withheld from the nav.
 */
const INVOICES = [
  { date: "Jun 1, 2026", amount: "$32.00", status: "Paid" },
  { date: "May 1, 2026", amount: "$32.00", status: "Paid" },
  { date: "Apr 1, 2026", amount: "$24.00", status: "Paid" },
];

export function BillingPanel() {
  return (
    <PanelGrid>
      <div className="flex flex-col gap-9">
        <PreviewBanner title="Billing is in preview" icon={<BillingIcon className="h-4 w-4" />}>
          Plans and invoices aren't live yet. This is a preview of the billing surface.
        </PreviewBanner>

        <section className={`${cardClass} p-[22px]`}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2.5">
                <span className="text-lg font-semibold text-stone-900 dark:text-stone-100">
                  Team
                </span>
                <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent)]">
                  Current plan
                </span>
              </div>
              <p className="mt-1.5 text-[13px] text-stone-500 dark:text-stone-400">
                $8 per member / month · renews Jul 1, 2026
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled
                className={`${smallButtonClass} cursor-not-allowed opacity-60`}
              >
                Change plan
              </button>
              <button
                type="button"
                disabled
                className={`${smallPrimaryButtonClass} cursor-not-allowed opacity-60`}
              >
                Manage
              </button>
            </div>
          </div>
          <div className="my-[18px] h-px bg-stone-200 dark:bg-stone-800" />
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[13px] text-stone-500 dark:text-stone-400">Sources tracked</span>
            <span className="font-mono text-[13px] font-medium text-stone-900 dark:text-stone-100">
              128 / 200
            </span>
          </div>
          <div className="h-[7px] overflow-hidden rounded-full bg-stone-100 dark:bg-stone-800">
            <div className="h-full w-[64%] rounded-full bg-[var(--accent)]" />
          </div>
        </section>

        <section>
          <div className="mb-3 text-sm font-semibold text-stone-900 dark:text-stone-100">
            Payment method
          </div>
          <div className={`flex items-center gap-3.5 ${cardClass} px-4 py-3.5`}>
            <span className="flex h-[30px] w-[42px] shrink-0 items-center justify-center rounded-md bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-300">
              <CardIcon className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
                •••• 4242
              </div>
              <div className="text-[12px] text-stone-400 dark:text-stone-500">Expires 09 / 28</div>
            </div>
            <span className="text-[13px] font-medium text-stone-300 dark:text-stone-600">
              Update
            </span>
          </div>
        </section>

        <section>
          <div className="mb-3 text-sm font-semibold text-stone-900 dark:text-stone-100">
            Invoices
          </div>
          <div className={listCardClass}>
            {INVOICES.map((inv) => (
              <div key={inv.date} className={listRowClass}>
                <span className="flex-1 font-mono text-[13.5px] text-stone-900 dark:text-stone-100">
                  {inv.date}
                </span>
                <span className="font-mono text-[13px] text-stone-500 dark:text-stone-400">
                  {inv.amount}
                </span>
                <span className="rounded-full bg-[var(--accent-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--accent)]">
                  {inv.status}
                </span>
                <span className="text-[13px] text-stone-300 dark:text-stone-600">PDF</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </PanelGrid>
  );
}
