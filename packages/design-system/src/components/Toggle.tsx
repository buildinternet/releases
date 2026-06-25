import type { ButtonHTMLAttributes } from "react";

/**
 * Toggle — pill switch for boolean settings.
 *
 * Accent track when on; controlled via `checked` + `onChange`.
 * `disabled` dims the control and blocks interaction (used for not-yet-wired
 * preferences). Renders as a `<button role="switch">` for assistive technology.
 */
export interface ToggleProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onChange"> {
  /** Whether the toggle is currently on. */
  checked: boolean;
  /** Called with the next value when the user clicks. */
  onChange: (next: boolean) => void;
  /** Accessible label surfaced via `aria-label`. */
  label: string;
}

/** Toggle — pill switch for boolean settings; controlled via `checked` and `onChange`. @category Forms */
export function Toggle({ checked, onChange, disabled, label, ...rest }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-[var(--accent)]" : "bg-stone-300 dark:bg-stone-600"
      }`}
      {...rest}
    >
      <span
        className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-[left] ${
          checked ? "left-[19px]" : "left-[3px]"
        }`}
      />
    </button>
  );
}
