import type { HTMLAttributes, ReactNode } from "react";
import { listCardClass, listRowClass } from "../classes";
import { cx } from "../cx";

/**
 * ListCard — a rounded, overflow-hidden container whose internal dividers are
 * managed by its `ListRow` children via `first:border-t-0`.
 *
 * Forwards all native `<div>` attributes; merges an optional `className`
 * after the base `listCardClass` so callers can extend without overriding.
 */
export interface ListCardProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

/** ListCard — rounded container managing dividers for its ListRow children. @category Layout */
export function ListCard({ className, children, ...rest }: ListCardProps) {
  return (
    <div className={cx(listCardClass, className)} {...rest}>
      {children}
    </div>
  );
}

/**
 * ListRow — one row inside a {@link ListCard}.
 *
 * Renders a top border that collapses automatically on the first child via
 * `first:border-t-0`. Meant to be a direct child of `ListCard`. Forwards all
 * native `<div>` attributes; merges an optional `className` after `listRowClass`.
 */
export interface ListRowProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

/** ListRow — one row inside a ListCard with auto-collapsing top border. @category Layout */
export function ListRow({ className, children, ...rest }: ListRowProps) {
  return (
    <div className={cx(listRowClass, className)} {...rest}>
      {children}
    </div>
  );
}
