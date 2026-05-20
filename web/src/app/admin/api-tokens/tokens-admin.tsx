"use client";

import { useCallback, useState, useTransition } from "react";
import { API_SCOPES, type ApiScope } from "@buildinternet/releases-core/api-token";
import { CopyIcon } from "@/components/copy-icon";
import { LocalTimestamp } from "@/components/local-timestamp";
import { useCopyToClipboard } from "@/lib/use-copy-to-clipboard";
import {
  listMyTokensAction,
  mintTokenAction,
  revokeTokenAction,
  type MintedTokenRow,
  type PublicTokenRow,
} from "@/app/actions/api-tokens";

const SCOPE_CLASS: Record<string, string> = {
  admin: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  write: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  read: "bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-400",
};

function ScopeBadge({ scope }: { scope: string }) {
  const cls = SCOPE_CLASS[scope] ?? SCOPE_CLASS.read;
  return <span className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${cls}`}>{scope}</span>;
}

function StatusBadge({ active }: { active: boolean }) {
  if (active) {
    return (
      <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
        active
      </span>
    );
  }
  return (
    <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-400">
      revoked
    </span>
  );
}

function MintedSecret({ token }: { token: string }) {
  const { copied, copy } = useCopyToClipboard();

  return (
    <div className="p-4 rounded-md border border-green-300 bg-green-50 dark:border-green-700 dark:bg-green-950/30">
      <p className="text-sm font-semibold text-green-800 dark:text-green-300 mb-1">
        Token created — copy it now
      </p>
      <p className="text-xs text-green-700 dark:text-green-400 mb-3">
        This secret will not be shown again. Store it somewhere safe before leaving this page.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs font-mono break-all bg-white dark:bg-stone-900 border border-green-200 dark:border-green-800 rounded px-2 py-1.5 text-stone-800 dark:text-stone-200">
          {token}
        </code>
        <button
          type="button"
          onClick={() => copy(token)}
          className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-green-300 dark:border-green-700 bg-white dark:bg-stone-900 text-stone-700 dark:text-stone-300 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors"
        >
          <CopyIcon copied={copied} size={13} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

interface MintFormProps {
  onMinted: (row: MintedTokenRow) => void;
}

function MintForm({ onMinted }: MintFormProps) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<ApiScope>>(new Set<ApiScope>(["read"]));
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggleScope(scope: ApiScope) {
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) {
        next.delete(scope);
      } else {
        next.add(scope);
      }
      return next;
    });
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    let expiresIso: string | undefined;
    if (expiresAt) {
      const parsed = new Date(expiresAt);
      if (Number.isNaN(parsed.getTime())) {
        setError("Expiry is not a valid date and time.");
        return;
      }
      expiresIso = parsed.toISOString();
    }

    startTransition(async () => {
      const result = await mintTokenAction({
        name: name.trim(),
        scopes: Array.from(scopes),
        expiresAt: expiresIso,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setName("");
      setScopes(new Set<ApiScope>(["read"]));
      setExpiresAt("");
      onMinted(result.token);
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="p-4 rounded-md border border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-900/50 space-y-4"
    >
      <h2 className="text-sm font-semibold text-stone-800 dark:text-stone-200">Mint new token</h2>
      <p className="text-xs text-stone-500 dark:text-stone-400">
        Tokens are issued under the primary owner principal (
        <code className="font-mono">usr_web_admin</code>) and appear in the table below.
      </p>

      <div className="space-y-1">
        <label
          htmlFor="token-name"
          className="block text-xs font-medium text-stone-700 dark:text-stone-300"
        >
          Name
        </label>
        <input
          id="token-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. local-dev"
          required
          className="w-full text-sm rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-3 py-1.5 text-stone-900 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:outline-none focus:ring-2 focus:ring-stone-400 dark:focus:ring-stone-600"
        />
      </div>

      <div className="space-y-1">
        <span className="block text-xs font-medium text-stone-700 dark:text-stone-300">Scopes</span>
        <div className="flex gap-4">
          {API_SCOPES.map((scope) => (
            <label key={scope} className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={scopes.has(scope)}
                onChange={() => toggleScope(scope)}
                className="rounded border-stone-300 dark:border-stone-600"
              />
              <span className="text-sm text-stone-700 dark:text-stone-300">{scope}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <label
          htmlFor="token-expires"
          className="block text-xs font-medium text-stone-700 dark:text-stone-300"
        >
          Expires (optional)
        </label>
        <input
          id="token-expires"
          type="datetime-local"
          value={expiresAt}
          onChange={(e) => setExpiresAt(e.target.value)}
          className="text-sm rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 px-3 py-1.5 text-stone-900 dark:text-stone-100 focus:outline-none focus:ring-2 focus:ring-stone-400 dark:focus:ring-stone-600"
        />
      </div>

      {error && <p className="text-xs text-red-600 dark:text-red-400 font-medium">{error}</p>}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex items-center px-4 py-1.5 text-sm font-medium rounded-md border border-stone-300 dark:border-stone-600 bg-white dark:bg-stone-900 text-stone-800 dark:text-stone-200 hover:bg-stone-100 dark:hover:bg-stone-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {pending ? "Minting..." : "Mint token"}
      </button>
    </form>
  );
}

interface TokenTableRowProps {
  token: PublicTokenRow;
  onRevoked: (updated: PublicTokenRow) => void;
}

function TokenTableRow({ token, onRevoked }: TokenTableRowProps) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleRevoke() {
    setError(null);
    startTransition(async () => {
      const result = await revokeTokenAction(token.id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onRevoked(result.token);
    });
  }

  return (
    <tr className="border-b border-stone-100 dark:border-stone-800 last:border-0">
      <td className="px-3 py-2.5 align-top">
        <span className="text-sm text-stone-800 dark:text-stone-200 font-medium">{token.name}</span>
        <div className="text-[10px] text-stone-400 dark:text-stone-500 font-mono mt-0.5">
          {token.lookupId}
        </div>
      </td>
      <td className="px-3 py-2.5 align-top">
        <div className="flex flex-wrap gap-1">
          {token.scopes.map((s) => (
            <ScopeBadge key={s} scope={s} />
          ))}
        </div>
      </td>
      <td className="px-3 py-2.5 align-top">
        <StatusBadge active={token.active} />
        {token.revokedAt && (
          <LocalTimestamp
            iso={token.revokedAt}
            className="block text-[10px] text-stone-400 dark:text-stone-500 mt-0.5"
          />
        )}
      </td>
      <td className="px-3 py-2.5 align-top text-xs text-stone-500 dark:text-stone-400 whitespace-nowrap">
        {token.lastUsedAt ? <LocalTimestamp iso={token.lastUsedAt} /> : "—"}
      </td>
      <td className="px-3 py-2.5 align-top text-xs text-stone-500 dark:text-stone-400 whitespace-nowrap">
        <LocalTimestamp iso={token.createdAt} />
      </td>
      <td className="px-3 py-2.5 align-top">
        {token.active ? (
          <>
            <button
              type="button"
              onClick={handleRevoke}
              disabled={pending}
              className="text-xs font-medium text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {pending ? "Revoking..." : "Revoke"}
            </button>
            {error && (
              <div className="text-[10px] text-red-500 dark:text-red-400 mt-0.5">{error}</div>
            )}
          </>
        ) : (
          <span className="text-xs text-stone-400 dark:text-stone-500">—</span>
        )}
      </td>
    </tr>
  );
}

export function TokensAdmin({
  initialTokens,
  initialError = null,
}: {
  initialTokens: PublicTokenRow[];
  initialError?: string | null;
}) {
  const [tokens, setTokens] = useState<PublicTokenRow[]>(initialTokens);
  const [mintedSecret, setMintedSecret] = useState<MintedTokenRow | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(initialError);
  const [refreshing, startRefreshTransition] = useTransition();

  const refresh = useCallback(() => {
    setRefreshError(null);
    startRefreshTransition(async () => {
      const result = await listMyTokensAction();
      if (!result.ok) {
        setRefreshError(result.error);
        return;
      }
      setTokens(result.tokens);
    });
  }, []);

  function handleMinted(row: MintedTokenRow) {
    setMintedSecret(row);
    // Strip the one-time secret before the row enters list state.
    const { token: _secret, ...publicRow } = row;
    setTokens((prev) => [publicRow, ...prev]);
  }

  function handleRevoked(updated: PublicTokenRow) {
    setTokens((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
  }

  return (
    <div className="space-y-8">
      <div className="text-xs text-stone-500 dark:text-stone-400 px-3 py-2 rounded-md bg-stone-100 dark:bg-stone-800 border border-stone-200 dark:border-stone-700">
        This page manages tokens issued under the primary owner principal (
        <code className="font-mono">usr_web_admin</code>). Tokens belonging to other principals or
        system tokens are not shown here.
      </div>

      <MintForm onMinted={handleMinted} />

      {mintedSecret && <MintedSecret token={mintedSecret.token} />}

      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-stone-800 dark:text-stone-200">
            Primary owner tokens
          </h2>
          <button
            type="button"
            onClick={refresh}
            disabled={refreshing}
            className="text-xs text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300 disabled:opacity-50 transition-colors"
          >
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {refreshError && (
          <p className="text-xs text-red-600 dark:text-red-400 mb-3">{refreshError}</p>
        )}

        {tokens.length === 0 ? (
          <p className="text-sm text-stone-400 dark:text-stone-500 py-6 text-center">
            No tokens found for this principal.
          </p>
        ) : (
          <div className="rounded-md border border-stone-200 dark:border-stone-700 overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="border-b border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-900/50">
                  <th className="px-3 py-2 text-xs font-medium text-stone-500 dark:text-stone-400">
                    Name
                  </th>
                  <th className="px-3 py-2 text-xs font-medium text-stone-500 dark:text-stone-400">
                    Scopes
                  </th>
                  <th className="px-3 py-2 text-xs font-medium text-stone-500 dark:text-stone-400">
                    Status
                  </th>
                  <th className="px-3 py-2 text-xs font-medium text-stone-500 dark:text-stone-400">
                    Last used
                  </th>
                  <th className="px-3 py-2 text-xs font-medium text-stone-500 dark:text-stone-400">
                    Created
                  </th>
                  <th className="px-3 py-2 text-xs font-medium text-stone-500 dark:text-stone-400">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <TokenTableRow key={t.id} token={t} onRevoked={handleRevoked} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
