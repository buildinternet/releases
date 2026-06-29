"use client";

/**
 * Shared presentational primitives for the OAuth/device authorization surface
 * (`/oauth/consent`, `/device/approve`). A card-based "approval" layout adapted
 * from the claude.ai/design "OAuth Approval" mock: a connection visual, a
 * balanced title with verified-domain identity, grouped permission rows driven
 * by the user's real scope entitlement, and a primary/outline action footer.
 *
 * Styling uses the brand `--accent` token (the logo blue) plus the stone palette
 * with `dark:` variants, so the whole surface tracks the site theme. The mock is
 * light-only; dark mode is added here. The functional controllers
 * (oauth-consent-form, device-approve-form) compose these pieces.
 */

import type { ReactNode, SVGProps } from "react";
import { useState } from "react";
import { SCOPE_LABELS } from "@/lib/entitlement";

/* ─────────────────────────── line icons ───────────────────────────
   Hand-rolled inline SVGs (no icon dependency, matching the rest of the
   codebase). Glyph paths mirror the design mock's lucide-style set. */

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

function Icon({ className = "h-[18px] w-[18px]", children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

const EyeIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);
const PencilIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </Icon>
);
const ShieldIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 2 4 5v6c0 5 3.4 8.5 8 11 4.6-2.5 8-6 8-11V5Z" />
    <path d="M12 8.5v4" />
    <path d="M12 16h.01" />
  </Icon>
);
const UserIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 20c1.5-4 4.5-6 8-6s6.5 2 8 6" />
  </Icon>
);
const MailIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3 7 9 6 9-6" />
  </Icon>
);
const ClockIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5V12l3 1.8" />
  </Icon>
);
const LockIcon = (p: IconProps) => (
  <Icon {...p}>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </Icon>
);
const ShieldCheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M12 2 4 5v6c0 5 3.4 8.5 8 11 4.6-2.5 8-6 8-11V5Z" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
);
const KeyIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="8" cy="15" r="3.2" />
    <path d="m10.3 12.7 7.2-7.2" />
    <path d="m15 5 3 3" />
    <path d="m17.5 7.5 1.8-1.8 2 2-1.8 1.8" />
  </Icon>
);
const ChevronDownIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);
const AlertIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    <path d="M12 9v4" />
    <path d="M12 17h.01" />
  </Icon>
);
const InfoIcon = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 16v-4" />
    <path d="M12 8h.01" />
  </Icon>
);
const CheckIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);
const XIcon = (p: IconProps) => (
  <Icon {...p}>
    <path d="M6 6l12 12" />
    <path d="M18 6 6 18" />
  </Icon>
);

/** releases.sh brand mark — rounded tile with the accent bottom bar. */
export function ReleasesLogo({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <rect width="64" height="64" rx="14" fill="#1c1917" />
      <rect x="14" y="18" width="28" height="6" rx="1.5" fill="#fafaf9" />
      <rect x="14" y="29" width="22" height="6" rx="1.5" fill="#fafaf9" opacity="0.7" />
      <rect x="14" y="40" width="36" height="6" rx="1.5" fill="oklch(0.6 0.18 252)" />
    </svg>
  );
}

/* ─────────────────────────── action buttons ─────────────────────────── */

const btnBase =
  "inline-flex h-[42px] flex-1 items-center justify-center gap-2 rounded-[11px] text-[14.5px] font-semibold transition disabled:cursor-default disabled:opacity-55";
export const primaryButtonClass = `${btnBase} bg-[var(--accent)] text-[var(--on-accent)] hover:brightness-110`;
export const outlineButtonClass = `${btnBase} border border-stone-200 bg-white text-stone-900 hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:hover:bg-stone-800`;

/* ─────────────────────────── card chrome ─────────────────────────── */

/** White card shell with an optional sticky-feeling action footer. */
export function AuthCard({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="w-full max-w-[460px] overflow-hidden rounded-[15px] bg-white shadow-[0_0_0_1px_rgba(28,25,23,0.09),0_8px_22px_-8px_rgba(28,25,23,0.1)] dark:bg-stone-900 dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_8px_22px_-8px_rgba(0,0,0,0.5)]">
      <div className="px-[26px] pb-[22px] pt-[26px]">{children}</div>
      {footer ? (
        <div className="flex gap-[11px] border-t border-stone-100 bg-stone-50/70 px-[26px] py-4 dark:border-stone-800 dark:bg-stone-950/40">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

/** App tile for the left side of the connection visual. */
function AppTile({
  letter,
  logo,
  terminal,
}: {
  letter?: string;
  logo?: string | null;
  terminal?: boolean;
}) {
  if (terminal) {
    return (
      <div className="flex h-[58px] w-[58px] items-center justify-center rounded-[15px] bg-gradient-to-br from-stone-700 to-stone-900 font-mono text-[22px] font-semibold text-emerald-300 shadow-sm">
        {">_"}
      </div>
    );
  }
  if (logo) {
    return (
      <div className="flex h-[58px] w-[58px] items-center justify-center overflow-hidden rounded-[15px] bg-white shadow-sm ring-1 ring-stone-200 dark:ring-stone-700">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logo} alt="" className="h-full w-full object-cover" />
      </div>
    );
  }
  return (
    <div className="flex h-[58px] w-[58px] items-center justify-center rounded-[15px] bg-stone-800 text-[23px] font-semibold text-stone-50 shadow-sm dark:bg-stone-700">
      {(letter || "?").slice(0, 1).toUpperCase()}
    </div>
  );
}

/** The app → releases connection visual: two tiles joined by a dashed node. */
export function ConnVisual({
  node,
  letter,
  logo,
  terminal,
}: {
  node: "lock" | "key";
  letter?: string;
  logo?: string | null;
  terminal?: boolean;
}) {
  const NodeIcon = node === "key" ? KeyIcon : LockIcon;
  return (
    <div className="mb-[18px] flex items-center justify-center">
      <AppTile letter={letter} logo={logo} terminal={terminal} />
      <div className="relative flex h-[58px] w-[70px] items-center justify-center">
        <span className="absolute inset-x-[6px] top-1/2 border-t-2 border-dashed border-stone-200 dark:border-stone-700" />
        <span className="relative flex h-[30px] w-[30px] items-center justify-center rounded-full border border-stone-200 bg-white text-stone-400 shadow-sm dark:border-stone-700 dark:bg-stone-900 dark:text-stone-500">
          <NodeIcon className="h-[15px] w-[15px]" />
        </span>
      </div>
      <ReleasesLogo size={58} />
    </div>
  );
}

/** Balanced, centered card heading (rendered as the page <h1>). */
export function CardTitle({ children }: { children: ReactNode }) {
  return (
    <h1 className="text-balance text-center text-[19px] font-semibold leading-[1.34] tracking-[-0.01em] text-stone-900 dark:text-stone-100">
      {children}
    </h1>
  );
}

/**
 * Brand mark + balanced title + optional subtitle, centered at the top of a card.
 * The login surface has no app→releases connection visual (nothing is connecting),
 * so it leads with the logo and `CardTitle` instead of `ConnVisual`. Shared by the
 * sign-in / sign-up / password-reset cards so they all open the same way.
 */
export function AuthHeading({ title, subtitle }: { title: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="mb-[22px] flex flex-col items-center">
      <ReleasesLogo size={40} className="mb-[14px]" />
      <CardTitle>{title}</CardTitle>
      {subtitle ? (
        <p className="text-pretty mt-[9px] text-center text-[13px] leading-[1.5] text-stone-500 dark:text-stone-400">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
}

/** Identity row under the title — verified domain or account email. */
export function IdentityRow({ verified, children }: { verified?: boolean; children: ReactNode }) {
  return (
    <div className="mt-[9px] flex items-center justify-center gap-1.5 text-[13px] text-stone-500 dark:text-stone-400">
      {verified ? (
        <span className="inline-flex text-green-600 dark:text-green-400" title="Verified domain">
          <ShieldCheckIcon className="h-[14px] w-[14px]" />
        </span>
      ) : null}
      <span className="font-mono text-[12.5px] text-stone-700 dark:text-stone-200">{children}</span>
    </div>
  );
}

export function Divider() {
  return <div className="my-[20px] h-px bg-stone-100 dark:bg-stone-800" />;
}

/** Footnote line: where the user can revoke access later. */
export function RevokeNote({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 flex items-center justify-center gap-1.5 text-center text-[12px] leading-[1.4] text-stone-400 dark:text-stone-500">
      <InfoIcon className="h-[13px] w-[13px] shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** Inline code chip used inside copy. */
export function Code({ children }: { children: ReactNode }) {
  return (
    <code className="font-mono text-[0.92em] text-stone-600 dark:text-stone-300">{children}</code>
  );
}

/** Amber caution panel (device approval safety note). */
export function Caution({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 flex items-start gap-[10px] rounded-[12px] border border-amber-200 bg-amber-50 px-[14px] py-3 dark:border-amber-500/30 dark:bg-amber-950/30">
      <AlertIcon className="mt-px h-[18px] w-[18px] shrink-0 text-amber-600 dark:text-amber-400" />
      <p className="text-pretty text-[12.5px] leading-[1.5] text-amber-800 dark:text-amber-200">
        {children}
      </p>
    </div>
  );
}

/** Monospace device-code chip. */
export function DeviceCode({ value }: { value: string }) {
  return (
    <div className="mb-[18px] flex items-center justify-between gap-3 rounded-[12px] border border-stone-200 bg-stone-50 px-[15px] py-3 dark:border-stone-700 dark:bg-stone-950/60">
      <span className="text-[12px] font-medium text-stone-500 dark:text-stone-400">
        Device code
      </span>
      <span className="font-mono text-[18px] font-semibold tracking-[0.26em] text-stone-900 dark:text-stone-100">
        {value}
      </span>
    </div>
  );
}

/* ─────────────────────────── permission groups ─────────────────────────── */

function Perm({
  icon: IconC,
  tone,
  title,
  desc,
  scope,
}: {
  icon: (p: IconProps) => ReactNode;
  tone: "blue" | "amber" | "neutral";
  title: string;
  desc: string;
  scope?: string;
}) {
  const toneCls =
    tone === "blue"
      ? "text-[var(--accent)]"
      : tone === "amber"
        ? "text-amber-600 dark:text-amber-400"
        : "text-stone-400 dark:text-stone-500";
  return (
    <div className="flex items-start gap-[11px] py-[7px]">
      <div className={`mt-px flex w-[19px] shrink-0 justify-center ${toneCls}`}>
        <IconC className="h-[18px] w-[18px]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-[7px] text-[13.5px] font-semibold leading-[1.35] text-stone-900 dark:text-stone-100">
          {title}
          {scope ? (
            <span className="font-mono text-[10px] text-stone-400 dark:text-stone-500">
              {scope}
            </span>
          ) : null}
        </div>
        <div className="text-pretty mt-px text-[12px] leading-[1.4] text-stone-500 dark:text-stone-400">
          {desc}
        </div>
      </div>
    </div>
  );
}

function PermGroup({
  label,
  badge,
  count,
  defaultOpen = true,
  children,
}: {
  label: string;
  badge?: string;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-[5px] border-t border-stone-100 pt-[13px] first:mt-0 first:border-0 first:pt-0 dark:border-stone-800">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-[10px] px-0.5 py-[3px] text-left"
      >
        <span className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.075em] text-stone-500 dark:text-stone-400">
          {label}
          {badge ? (
            <span className="inline-flex items-center rounded-full border border-amber-200 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.07em] text-amber-600 dark:border-amber-500/40 dark:text-amber-400">
              {badge}
            </span>
          ) : null}
        </span>
        <span className="flex-1" />
        {count != null ? (
          <span className="font-mono text-[11px] text-stone-400 dark:text-stone-500">{count}</span>
        ) : null}
        <ChevronDownIcon
          className={`h-[15px] w-[15px] text-stone-400 transition-transform dark:text-stone-500 ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open ? <div className="flex flex-col">{children}</div> : null}
    </div>
  );
}

/* Scope → presentation mapping. `group` buckets scopes into the three sections;
   icon/tone drive each row. Titles/descriptions come from SCOPE_LABELS so the
   copy stays in sync with the worker's entitlement source of truth. */
type ScopeGroupKey = "action" | "admin" | "account";
const SCOPE_META: Record<
  string,
  { group: ScopeGroupKey; icon: (p: IconProps) => ReactNode; tone: "blue" | "amber" | "neutral" }
> = {
  read: { group: "action", icon: EyeIcon, tone: "blue" },
  write: { group: "action", icon: PencilIcon, tone: "blue" },
  admin: { group: "admin", icon: ShieldIcon, tone: "amber" },
  openid: { group: "account", icon: ShieldCheckIcon, tone: "neutral" },
  profile: { group: "account", icon: UserIcon, tone: "neutral" },
  email: { group: "account", icon: MailIcon, tone: "neutral" },
  offline_access: { group: "account", icon: ClockIcon, tone: "neutral" },
};

const GROUP_ORDER: {
  key: ScopeGroupKey;
  label: (app: string) => string;
  badge?: string;
  defaultOpen: boolean;
}[] = [
  { key: "action", label: (app) => `What ${app} can do`, defaultOpen: true },
  { key: "admin", label: () => "Admin access", badge: "Elevated", defaultOpen: true },
  { key: "account", label: () => "Account info it can access", defaultOpen: false },
];

/**
 * Renders the requested+entitled scopes as grouped permission rows. Unknown
 * scopes fall back to the account group with a neutral shield so a future scope
 * never renders blank. Empty groups are skipped.
 */
export function ScopeGroups({ appName, scopes }: { appName: string; scopes: string[] }) {
  return (
    <>
      {GROUP_ORDER.map(({ key, label, badge, defaultOpen }) => {
        const inGroup = scopes.filter((s) => (SCOPE_META[s]?.group ?? "account") === key);
        if (inGroup.length === 0) return null;
        return (
          <PermGroup
            key={key}
            label={label(appName)}
            badge={badge}
            count={inGroup.length}
            defaultOpen={defaultOpen}
          >
            {inGroup.map((scope) => {
              const meta = SCOPE_META[scope] ?? { icon: ShieldIcon, tone: "neutral" as const };
              const label2 = SCOPE_LABELS[scope] ?? { title: scope, desc: "" };
              return (
                <Perm
                  key={scope}
                  icon={meta.icon}
                  tone={meta.tone}
                  title={label2.title}
                  desc={label2.desc}
                  scope={scope}
                />
              );
            })}
          </PermGroup>
        );
      })}
    </>
  );
}

/* ─────────────────────────── outcome ─────────────────────────── */

/** Terminal approved/denied result card (device flow stays on the page). */
export function OutcomeCard({ approved, children }: { approved: boolean; children: ReactNode }) {
  return (
    <AuthCard>
      <div
        role="status"
        className={`flex items-start gap-[13px] rounded-[13px] p-[18px] ${
          approved
            ? "border border-green-200 bg-green-50 dark:border-green-500/30 dark:bg-green-950/30"
            : "border border-stone-200 bg-stone-50 dark:border-stone-700 dark:bg-stone-950/40"
        }`}
      >
        <span
          className={`flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full text-white ${
            approved ? "bg-green-600" : "bg-stone-400 dark:bg-stone-600"
          }`}
        >
          {approved ? (
            <CheckIcon className="h-[18px] w-[18px]" />
          ) : (
            <XIcon className="h-[18px] w-[18px]" />
          )}
        </span>
        <div>
          <div
            className={`text-[14.5px] font-semibold leading-[1.3] ${
              approved ? "text-green-700 dark:text-green-300" : "text-stone-700 dark:text-stone-200"
            }`}
          >
            {approved ? "Approved" : "Denied"}
          </div>
          <div className="text-pretty mt-[5px] text-[13px] leading-[1.5] text-stone-600 dark:text-stone-300">
            {children}
          </div>
        </div>
      </div>
    </AuthCard>
  );
}

/** Centered page wrapper for the auth surface (below the site header). */
export function AuthCenter({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-[520px] flex-col items-center px-5 py-12 sm:py-16">
      {children}
    </div>
  );
}

/** Small error line shared by the forms. */
export function AuthError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-4 text-center text-[13px] text-red-600 dark:text-red-400">
      {children}
    </p>
  );
}
