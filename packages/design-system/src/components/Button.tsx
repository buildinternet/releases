import type { ButtonHTMLAttributes, ReactNode } from "react";
import {
  confirmRemoveButtonClass,
  dangerLinkClass,
  primaryButtonClass,
  secondaryButtonClass,
  smallButtonClass,
  smallPrimaryButtonClass,
} from "../classes";
import { cx } from "../cx";

export type ButtonVariant = "primary" | "secondary" | "danger" | "confirm";
export type ButtonSize = "md" | "sm";

/**
 * Button — the action vocabulary of the settings & org surfaces.
 *
 * `variant` picks the look, `size` picks the height for the neutral/accent pair:
 * - `primary` — filled brand-accent action (the page's main CTA).
 * - `secondary` — bordered neutral action.
 * - `danger` — quiet link-style destructive control (Remove/Revoke row actions).
 * - `confirm` — bordered red "are you sure" button shown after a danger click.
 *
 * `size="sm"` swaps `primary`/`secondary` to their compact (h-9) inline form;
 * `danger` and `confirm` are single-size. Falls back to the brand-accent primary.
 */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
}

function resolveClass(variant: ButtonVariant, size: ButtonSize): string {
  switch (variant) {
    case "secondary":
      return size === "sm" ? smallButtonClass : secondaryButtonClass;
    case "danger":
      return dangerLinkClass;
    case "confirm":
      return confirmRemoveButtonClass;
    case "primary":
    default:
      return size === "sm" ? smallPrimaryButtonClass : primaryButtonClass;
  }
}

/** Button — versatile action control with variant and size options. @category Actions */
export function Button({
  variant = "primary",
  size = "md",
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  const base = resolveClass(variant, size);
  return (
    <button type={type} className={cx(base, className)} {...rest}>
      {children}
    </button>
  );
}
