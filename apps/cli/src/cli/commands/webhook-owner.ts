/**
 * Shared `--workspace <id-or-slug>` resolution + error translation for
 * `releases webhook …` — see releases-cli#406. A workspace-owned webhook
 * hits `/v1/workspaces/:id/webhooks` instead of `/v1/me/webhooks`; the base
 * path is parameterized in `src/api/me-webhooks.ts` (`WebhookOwner`), and
 * this module resolves the flag into that owner and turns the two
 * workspace-specific failure modes (403 = member without manage rights, 404
 * = webhook id not in that workspace) into the plain messages the CLI wants instead of
 * a raw API error passthrough.
 */
import { CliError, ApiError } from "../../lib/errors.js";
import { resolveWorkspace, type MeWorkspace } from "../../api/workspaces.js";
import { MY_WEBHOOKS, type WebhookOwner } from "../../api/me-webhooks.js";

export interface ResolvedWebhookOwner {
  owner: WebhookOwner;
  /** Set only when `--workspace` resolved to a real workspace. */
  workspace?: MeWorkspace;
}

/**
 * Resolve `--workspace <id-or-slug>` into a `WebhookOwner`. No flag → the
 * caller's own `/v1/me/webhooks`. An unresolvable value throws a `CliError`
 * listing the caller's own workspaces (name, slug, id) so they can copy the
 * right one, instead of a bare "not found".
 */
export async function resolveWebhookOwner(
  workspaceIdentifier: string | undefined,
): Promise<ResolvedWebhookOwner> {
  if (!workspaceIdentifier) return { owner: MY_WEBHOOKS };
  const { match, all } = await resolveWorkspace(workspaceIdentifier);
  if (!match) {
    const lines = [`Workspace '${workspaceIdentifier}' not found among your workspaces.`];
    if (all.length === 0) {
      lines.push("You are not a member of any workspace.");
    } else {
      lines.push("Your workspaces:");
      for (const w of all) {
        lines.push(`  ${w.name}  (slug: ${w.slug}, id: ${w.id}, role: ${w.role})`);
      }
    }
    throw new CliError(lines.join("\n"));
  }
  return { owner: { kind: "workspace", id: match.id }, workspace: match };
}

/**
 * Reject `add --scope follows --workspace …` before any request is sent —
 * workspace webhooks are org-scoped only, there is no workspace follows
 * scope.
 */
export function assertWorkspaceScopeSupported(
  workspaceIdentifier: string | undefined,
  scope: string,
): void {
  if (workspaceIdentifier && scope === "follows") {
    throw new CliError(
      "Workspace webhooks are org-scoped only — --scope follows isn't supported with --workspace.",
    );
  }
}

/**
 * Translate a 403/404 from a workspace-scoped call into the CLI's own
 * plain-language message instead of passing the raw API error through. Any
 * other status, or a user-owned (`/v1/me/webhooks`) call, rethrows as-is.
 *
 * `--workspace` is resolved against the caller's own workspace list before
 * any webhook request, so membership is already confirmed by the time a 404
 * comes back: it means the webhook id isn't in that workspace.
 */
export function translateWebhookApiError(err: unknown, owner: WebhookOwner): never {
  if (owner.kind === "workspace" && err instanceof ApiError) {
    if (err.status === 403) {
      throw new CliError("Only workspace owners and admins can change workspace webhooks.");
    }
    if (err.status === 404) {
      throw new CliError(
        "Webhook not found in this workspace. Run `releases webhook list --workspace <workspace>` to see its webhooks.",
      );
    }
  }
  throw err;
}
