import type { HTMLAttributes, ReactNode } from "react";
import { eyebrowClass, orgEyebrowClass } from "../classes";
import { cx } from "../cx";

/**
 * Eyebrow — a small uppercase mono kicker label for section headings and rail labels.
 *
 * `tone="default"` uses the neutral `eyebrowClass`; `tone="accent"` uses the
 * brand-accent `orgEyebrowClass`. Merges an optional `className` after the resolved
 * base class so callers can extend without overriding.
 */
export interface EyebrowProps extends HTMLAttributes<HTMLDivElement> {
  tone?: "default" | "accent";
  children?: ReactNode;
}

/** Eyebrow — small uppercase mono kicker label for section headings and rail labels. @category Layout */
export function Eyebrow({ tone = "default", className, children, ...rest }: EyebrowProps) {
  const base = tone === "accent" ? orgEyebrowClass : eyebrowClass;
  return (
    <div className={cx(base, className)} {...rest}>
      {children}
    </div>
  );
}
