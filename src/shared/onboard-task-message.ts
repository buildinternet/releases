/**
 * Builds the user-message task block sent at the start of an onboard
 * managed-agents session. Pure function so it can be unit-tested without
 * spinning up a Durable Object.
 *
 * Coordinator agents already carry their full system prompt on the agent
 * definition, so what they receive is just `<task>` plus seed data.
 * The legacy single-agent path concatenates `buildDiscoverySystemPrompt`
 * with this block — see `managed-agents-session.ts`.
 *
 * Scope amendment (issue #794, item 4): when `intoOrgSlug` is set, the
 * `<task>` block carries an authoritative SCOPE OVERRIDE that tells the
 * agent to attach all sources to the supplied org/product instead of
 * auto-creating new ones. The `<scope>` data tag mirrors the structured
 * inputs the agent can reference downstream.
 */

import { escapeForPromptTag } from "@releases/lib/prompt-escape";

export interface OnboardTaskMessageOptions {
  company: string;
  domain?: string;
  githubOrg?: string;
  intoOrgSlug?: string;
  intoProductSlug?: string;
}

export function buildOnboardTaskMessage(opts: OnboardTaskMessageOptions): string {
  const domainBlock = opts.domain ? `\n<domain>${escapeForPromptTag(opts.domain)}</domain>` : "";
  const githubOrgBlock = opts.githubOrg
    ? `\n<github_org>${escapeForPromptTag(opts.githubOrg)}</github_org>`
    : "";

  const orgSlug = opts.intoOrgSlug ? escapeForPromptTag(opts.intoOrgSlug) : null;
  const productSlug = opts.intoProductSlug ? escapeForPromptTag(opts.intoProductSlug) : null;
  const scopeInstruction = orgSlug
    ? `\n\nSCOPE OVERRIDE: Attach every source you add to the existing org \`${orgSlug}\`${
        productSlug ? ` and product \`${productSlug}\`` : ""
      }. Do NOT call manage_org(action=add) or manage_product(action=add) — both already exist. Pass \`organization="${orgSlug}"\`${
        productSlug ? ` and \`product="${productSlug}"\`` : ""
      } on every manage_source(action=add). Skip the playbook step if it already exists for this org.`
    : "";
  const scopeBlock = orgSlug
    ? `\n<scope>
into_org=${orgSlug}${productSlug ? `\ninto_product=${productSlug}` : ""}
</scope>`
    : "";

  return `<task>
Find and evaluate changelog sources for the company described in <company>.${domainBlock ? " Their website domain is in <domain>." : ""}${githubOrgBlock ? " Their GitHub organization is in <github_org>." : ""}${scopeInstruction}
</task>

<company>${escapeForPromptTag(opts.company)}</company>${domainBlock}${githubOrgBlock}${scopeBlock}`;
}
