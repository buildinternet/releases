import { PanelGrid } from "@/components/account/settings-section";
import {
  Aside,
  PreviewBanner,
  listCardClass,
  listRowClass,
  inputClass,
  primaryButtonClass,
} from "@/components/account/ui";
import { ChevronDownIcon, MailIcon } from "@/components/account/icons";

/**
 * Workspace "Members" — preview/static. The org plugin can model members/roles,
 * but no UI is wired yet, so this is a faithful mockup withheld from the nav.
 */
const MEMBERS = [
  {
    name: "Maya Chen",
    email: "maya@rally.space",
    role: "Owner",
    initial: "M",
    color: "oklch(0.60 0.18 252)",
    you: true,
  },
  {
    name: "Jordan Lee",
    email: "jordan@rally.space",
    role: "Admin",
    initial: "J",
    color: "oklch(0.58 0.17 150)",
  },
  {
    name: "Priya Patel",
    email: "priya@rally.space",
    role: "Member",
    initial: "P",
    color: "oklch(0.60 0.18 30)",
  },
  {
    name: "Sam Rivera",
    email: "sam@rally.space",
    role: "Member",
    initial: "S",
    color: "oklch(0.58 0.16 300)",
  },
];

const ROLES = [
  { name: "Owner", desc: "Full control, including billing and deletion." },
  { name: "Admin", desc: "Manage members, sources, and settings." },
  { name: "Member", desc: "View and curate releases." },
];

export function MembersPanel() {
  return (
    <PanelGrid
      aside={
        <Aside label="Roles">
          <div className="flex flex-col gap-3">
            {ROLES.map((r) => (
              <div key={r.name}>
                <div className="text-[13px] font-semibold text-stone-900 dark:text-stone-100">
                  {r.name}
                </div>
                <div className="text-[12.5px] leading-snug text-stone-600 dark:text-stone-300">
                  {r.desc}
                </div>
              </div>
            ))}
          </div>
        </Aside>
      }
    >
      <div className="flex flex-col gap-9">
        <PreviewBanner
          title="Member management is in preview"
          icon={<MailIcon className="h-4 w-4" />}
        >
          Inviting teammates and assigning roles is coming soon.
        </PreviewBanner>

        <section>
          <div className="mb-3 text-sm font-semibold text-stone-900 dark:text-stone-100">
            Invite members
          </div>
          <div className="flex gap-2.5">
            <input disabled placeholder="name@company.com" className={`${inputClass} flex-1`} />
            <button
              type="button"
              disabled
              className={`${primaryButtonClass} shrink-0 cursor-not-allowed opacity-60`}
            >
              Send invite
            </button>
          </div>
        </section>

        <section>
          <div className="mb-3 text-sm font-semibold text-stone-900 dark:text-stone-100">
            Members · {MEMBERS.length}
          </div>
          <div className={listCardClass}>
            {MEMBERS.map((m) => (
              <div key={m.email} className={listRowClass}>
                <span
                  className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full text-[13px] font-semibold text-white"
                  style={{ background: m.color }}
                >
                  {m.initial}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px] font-medium text-stone-900 dark:text-stone-100">
                    {m.name}
                    {m.you && <span className="font-normal text-stone-400"> · you</span>}
                  </div>
                  <div className="text-[12.5px] text-stone-400 dark:text-stone-500">{m.email}</div>
                </div>
                <span className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 text-[12.5px] text-stone-600 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300">
                  {m.role}
                  <ChevronDownIcon className="h-3 w-3" />
                </span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </PanelGrid>
  );
}
