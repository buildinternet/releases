import type { ReactNode } from "react";

export function AccountSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
          {title}
        </h1>
        {description && (
          <p className="mt-3 max-w-prose text-sm leading-6 text-stone-500 dark:text-stone-400">
            {description}
          </p>
        )}
      </header>
      {children}
    </div>
  );
}
