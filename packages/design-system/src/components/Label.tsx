import type { LabelHTMLAttributes } from "react";
import { fieldLabelClass } from "../classes";
import { cx } from "../cx";

/**
 * Label — a styled `<label>` for pairing with form fields.
 *
 * Forwards all native `<label>` attributes; merges an optional `className`
 * after the base `fieldLabelClass` so callers can extend without overriding.
 */
export type LabelProps = LabelHTMLAttributes<HTMLLabelElement>;

/** Label — styled `<label>` for pairing with form fields. @category Forms */
export function Label({ className, children, ...rest }: LabelProps) {
  return (
    <label className={cx(fieldLabelClass, className)} {...rest}>
      {children}
    </label>
  );
}
