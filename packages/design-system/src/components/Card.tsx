import type { HTMLAttributes, ReactNode } from "react";
import { cardClass } from "../classes";
import { cx } from "../cx";

/**
 * Card — a bordered, rounded container for grouping related settings or content.
 *
 * Forwards all native `<div>` attributes; merges an optional `className`
 * after the base `cardClass` so callers can extend without overriding.
 */
export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

/** Card — bordered, rounded container for grouping related settings or content. @category Layout */
export function Card({ className, children, ...rest }: CardProps) {
  return (
    <div className={cx(cardClass, className)} {...rest}>
      {children}
    </div>
  );
}
