"use client";

import { useRef, useState } from "react";
import { smallButtonClass } from "@/components/account/ui";

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

export function AvatarUploadButton({
  label = "Upload",
  disabled,
  onUpload,
}: {
  label?: string;
  disabled?: boolean;
  onUpload: (file: File) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onUpload(file);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="sr-only"
        onChange={onChange}
        disabled={disabled || busy}
      />
      <button
        type="button"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
        className={smallButtonClass}
      >
        {busy ? "Uploading…" : label}
      </button>
      {error && (
        <p role="alert" className="max-w-xs text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
