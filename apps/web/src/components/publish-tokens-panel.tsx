"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  fieldLabelClass,
  inputClass,
  secondaryButtonClass,
  listCardClass,
  listRowClass,
  dangerLinkClass,
} from "@releases/design-system";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { sourcePath } from "@/lib/links";
import {
  listPublishTokens,
  listPublishableSources,
  createPublishToken,
  revokePublishToken,
  publishWorkflowSnippet,
  type CreatedPublishToken,
  type PublishToken,
  type PublishableSource,
} from "@/lib/publish-tokens";

const DOCS_HREF = "/docs/integrations/github-actions";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-3.5 text-sm font-semibold text-stone-900 dark:text-stone-100">
        Publish tokens
      </div>
      {children}
    </section>
  );
}

type Loaded = { tokens: PublishToken[]; sources: PublishableSource[]; verifiedOrgCount: number };

/**
 * Publish tokens (#2387): a verified domain owner mints a token bound to one of
 * their org's sources for the publish-changelog GitHub Action. Renders nothing
 * when the listing lane is off (both routes 404), and a single pointer line
 * when the caller holds no verified claim and no tokens.
 */
export function PublishTokensPanel() {
  const [data, setData] = useState<Loaded | null>(null);
  const [hidden, setHidden] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [sourceId, setSourceId] = useState("");
  const [name, setName] = useState("GitHub Actions");
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<CreatedPublishToken | null>(null);
  const [copied, setCopied] = useState<"token" | "snippet" | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [tokens, publishable] = await Promise.all([
        listPublishTokens(),
        listPublishableSources(),
      ]);
      if (tokens == null || publishable == null) {
        setHidden(true);
        return;
      }
      const { sources, verifiedOrgCount } = publishable;
      setData({ tokens, sources, verifiedOrgCount });
      setSourceId((current) => current || sources[0]?.id || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load publish tokens");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const byOrg = useMemo(() => {
    const groups = new Map<
      string,
      { orgSlug: string; orgName: string; sources: PublishableSource[] }
    >();
    for (const s of data?.sources ?? []) {
      const g = groups.get(s.orgSlug) ?? { orgSlug: s.orgSlug, orgName: s.orgName, sources: [] };
      g.sources.push(s);
      groups.set(s.orgSlug, g);
    }
    return [...groups.values()];
  }, [data]);

  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (creating || !sourceId || !name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      setRevealed(await createPublishToken({ sourceId, name: name.trim() }));
      setCopied(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create publish token");
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(id: string) {
    setError(null);
    try {
      await revokePublishToken(id);
      setConfirmId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke publish token");
    }
  }

  async function onCopy(kind: "token" | "snippet", text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
    } catch {
      // The token is shown once — tell the user to copy by hand rather than fail silently.
      setCopied(null);
      setError("Could not copy automatically. Select and copy the text above before dismissing.");
    }
  }

  if (hidden) return null;

  if (!data) {
    return (
      <Section>
        {error ? (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        ) : (
          <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>
        )}
      </Section>
    );
  }

  // Nothing to manage and nothing to mint for: one line, no form.
  if (data.tokens.length === 0 && data.sources.length === 0) {
    return (
      <Section>
        <p className="text-sm leading-6 text-stone-500 dark:text-stone-400">
          {data.verifiedOrgCount > 0
            ? "Your verified organization has no sources yet. Once it’s tracked, you can mint a token here to publish release notes straight from GitHub Actions."
            : "Own a domain listed on Releases Index? Verify it from your organization’s page, then mint a token here to publish release notes straight from GitHub Actions."}{" "}
          <Link href={DOCS_HREF} className="underline">
            How it works
          </Link>
        </p>
      </Section>
    );
  }

  return (
    <Section>
      <div className="space-y-4">
        <p className="text-sm leading-6 text-stone-500 dark:text-stone-400">
          A publish token lets a GitHub Action push release notes to one of your sources, and does
          nothing else.{" "}
          <Link href={DOCS_HREF} className="underline">
            Set up the Action
          </Link>
        </p>

        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        {revealed && (
          <div className="rounded-xl border border-green-600/30 bg-green-50 p-4 dark:border-green-500/30 dark:bg-green-950/40">
            <p className="text-sm font-medium text-green-800 dark:text-green-300">
              Token created. Copy it now. It won&rsquo;t be shown again.
            </p>
            <code className="mt-3 block overflow-x-auto whitespace-nowrap rounded-lg border border-green-600/30 bg-white px-3 py-2 font-mono text-xs text-stone-900 dark:bg-stone-950 dark:text-stone-100">
              {revealed.token}
            </code>
            <p className="mt-3 text-sm text-green-800 dark:text-green-300">
              Save it as a repository secret named <code>RELEASES_API_TOKEN</code>, then add this
              step to your workflow:
            </p>
            <pre className="mt-2 overflow-x-auto rounded-lg border border-green-600/30 bg-white px-3 py-2 font-mono text-xs text-stone-900 dark:bg-stone-950 dark:text-stone-100">
              {publishWorkflowSnippet(revealed.sourceId)}
            </pre>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void onCopy("token", revealed.token)}
                className={secondaryButtonClass}
              >
                {copied === "token" ? "Copied" : "Copy token"}
              </button>
              <button
                type="button"
                onClick={() => void onCopy("snippet", publishWorkflowSnippet(revealed.sourceId))}
                className={secondaryButtonClass}
              >
                {copied === "snippet" ? "Copied" : "Copy workflow step"}
              </button>
              <button
                type="button"
                onClick={() => setRevealed(null)}
                className={secondaryButtonClass}
              >
                I&rsquo;ve saved it
              </button>
            </div>
          </div>
        )}

        {data.sources.length > 0 && (
          <form
            onSubmit={onCreate}
            className="space-y-4 rounded-xl border border-stone-200 p-5 dark:border-stone-800"
          >
            <div>
              <label htmlFor="publish-token-source" className={fieldLabelClass}>
                Source
              </label>
              <select
                id="publish-token-source"
                value={sourceId}
                onChange={(e) => setSourceId(e.target.value)}
                className={inputClass}
                required
              >
                {byOrg.map((g) => (
                  <optgroup key={g.orgSlug} label={g.orgName}>
                    {g.sources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="publish-token-name" className={fieldLabelClass}>
                Name
              </label>
              <input
                id="publish-token-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                className={inputClass}
                required
              />
            </div>
            <button
              type="submit"
              disabled={creating || !sourceId || !name.trim()}
              className={secondaryButtonClass}
            >
              {creating ? "Creating…" : "Create token"}
            </button>
          </form>
        )}

        {data.tokens.length > 0 && (
          <ul className={listCardClass}>
            {data.tokens.map((t) => (
              <li key={t.id} className={listRowClass}>
                <div className="min-w-0 flex-1">
                  <p
                    className={`truncate text-sm font-medium ${
                      t.revokedAt
                        ? "text-stone-400 line-through dark:text-stone-500"
                        : "text-stone-900 dark:text-stone-100"
                    }`}
                  >
                    {t.name}
                  </p>
                  <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
                    {t.sourceSlug ? (
                      <Link href={sourcePath(t.orgSlug, t.sourceSlug)} className="hover:underline">
                        {t.orgSlug ? `${t.orgSlug}/${t.sourceSlug}` : t.sourceSlug}
                      </Link>
                    ) : (
                      <span className="font-mono">{t.sourceId}</span>
                    )}
                    {" · "}created {formatDate(t.createdAt)}
                    {" · "}
                    {t.lastUsedAt ? `last used ${formatDate(t.lastUsedAt)}` : "never used"}
                    {t.revokedAt ? ` · revoked ${formatDate(t.revokedAt)}` : ""}
                  </p>
                </div>
                {!t.revokedAt && (
                  <button
                    type="button"
                    onClick={() => setConfirmId(t.id)}
                    className={dangerLinkClass}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        <ConfirmDialog
          open={confirmId != null}
          onOpenChange={(open) => {
            if (!open) setConfirmId(null);
          }}
          title="Revoke publish token"
          description="Any workflow using this token will fail on its next run. You can't undo this."
          confirmLabel="Revoke"
          onConfirm={() => {
            if (confirmId) void onRevoke(confirmId);
          }}
        />
      </div>
    </Section>
  );
}
