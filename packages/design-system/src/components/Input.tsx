import type { InputHTMLAttributes } from "react";
import { inputClass } from "../classes";
import { cx } from "../cx";

/**
 * Input — a styled text input for settings forms and inline fields.
 *
 * Forwards all native `<input>` attributes; merges an optional `className`
 * after the base `inputClass` so callers can extend without overriding.
 */
export type InputProps = InputHTMLAttributes<HTMLInputElement>;

/** Input — styled text input for settings forms and inline fields. @category Forms */
export function Input({ className, ...rest }: InputProps) {
  return <input className={cx(inputClass, className)} {...rest} />;
}
