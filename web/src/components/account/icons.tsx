/**
 * Line-icon set for the account settings surface — sidebar nav, the header
 * account dropdown, and the panels. Each icon inherits `currentColor` so the
 * caller controls color (the active nav item tints its icon with the accent),
 * and takes a `className` for sizing. Stroke-based at 1.5–1.7 to match the
 * Settings Redesign source. Kept inline (no icon dependency) like the rest of
 * the codebase's hand-rolled SVGs.
 */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { className?: string };

function Icon({ className = "h-[17px] w-[17px]", children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
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

export function ProfileIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <circle cx="12" cy="8" r="3.2" />
      <path d="M5.5 20a6.5 6.5 0 0 1 13 0" />
    </Icon>
  );
}

export function SecurityIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Icon>
  );
}

export function BellIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6z" />
      <path d="M10 20a2 2 0 0 0 4 0" />
    </Icon>
  );
}

export function CollectionsIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M6 4h12v17l-6-4-6 4z" />
    </Icon>
  );
}

export function GeneralIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 8h3M8 12h3M8 16h3M14 8h2M14 12h2" />
    </Icon>
  );
}

export function MembersIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
      <path d="M16 6.2a3 3 0 0 1 0 5.6M17 19a5.5 5.5 0 0 0-2.5-4.6" />
    </Icon>
  );
}

export function BillingIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M3 10h18M7 14h4" />
    </Icon>
  );
}

export function IntegrationsIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M10 4v3a2 2 0 0 1-2 2H5M14 4v3a2 2 0 0 0 2 2h3M6 9v4a6 6 0 0 0 12 0V9" />
      <path d="M12 19v2" />
    </Icon>
  );
}

export function WebhooksIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M9 8l-4 4 4 4M15 8l4 4-4 4" />
    </Icon>
  );
}

export function DangerIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17.5v.01" />
    </Icon>
  );
}

export function ChevronSelectorIcon(p: IconProps) {
  return (
    <Icon {...p} strokeWidth={1.7}>
      <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />
    </Icon>
  );
}

export function ChevronDownIcon(p: IconProps) {
  return (
    <Icon {...p} strokeWidth={1.7}>
      <path d="M6 9l6 6 6-6" />
    </Icon>
  );
}

export function CheckIcon(p: IconProps) {
  return (
    <Icon {...p} strokeWidth={2.2}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </Icon>
  );
}

export function PlusIcon(p: IconProps) {
  return (
    <Icon {...p} strokeWidth={1.6}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function SignOutIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
    </Icon>
  );
}

export function ExternalLinkIcon(p: IconProps) {
  return (
    <Icon {...p} strokeWidth={1.7}>
      <path d="M7 17L17 7M9 7h8v8" />
    </Icon>
  );
}

export function HeartIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M12 21s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 11c0 5.5-7 10-7 10z" />
    </Icon>
  );
}

export function ShieldIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M12 3l8 4v5c0 4.5-3.2 7.5-8 9-4.8-1.5-8-4.5-8-9V7z" />
    </Icon>
  );
}

export function KeyIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <circle cx="9" cy="11" r="3" />
      <path d="M12 11h9M18 11v3M15 11v2" />
    </Icon>
  );
}

export function DeviceIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <rect x="3" y="5" width="18" height="12" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </Icon>
  );
}

export function MailIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M4 7l8 6 8-6" />
    </Icon>
  );
}

export function CardIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <path d="M2 10h20" />
    </Icon>
  );
}

export function McpIcon(p: IconProps) {
  return (
    <Icon {...p} strokeWidth={1.7}>
      <path d="M4 17l6-6-6-6M12 19h8" />
    </Icon>
  );
}

export function TerminalIcon(p: IconProps) {
  return (
    <Icon {...p} strokeWidth={1.7}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </Icon>
  );
}

export function StarIcon(p: IconProps) {
  return (
    <Icon {...p}>
      <path d="M12 3l1.9 4.6L18 9l-3.5 3 1 4.6L12 14.8 8.5 16.6l1-4.6L6 9l4.1-1.4z" />
    </Icon>
  );
}

export function CloseIcon(p: IconProps) {
  return (
    <Icon {...p} strokeWidth={1.8}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Icon>
  );
}
