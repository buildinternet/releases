import type { TextareaHTMLAttributes } from "react";
import { textareaClass } from "../classes";
import { cx } from "../cx";

/**
 * Textarea — a styled multi-line text input for settings forms.
 *
 * Forwards all native `<textarea>` attributes; merges an optional `className`
 * after the base `textareaClass` so callers can extend without overriding.
 */
export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

/** Textarea — styled multi-line text input for settings forms. @category Forms */
export function Textarea({ className, ...rest }: TextareaProps) {
  return <textarea className={cx(textareaClass, className)} {...rest} />;
}
