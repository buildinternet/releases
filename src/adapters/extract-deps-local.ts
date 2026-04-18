/**
 * Local (CLI/Bun) ExtractDeps implementation. The CLI talks to either the
 * local SQLite DB or the remote API via the mode router in `src/db/queries.ts`
 * + `src/api/client.ts`, so this shim just threads those calls through.
 */

import type { Source } from "@buildinternet/releases-core/schema";
import type { ExtractDeps, ExtractRepo } from "@releases/adapters/extract/types";
import { config } from "@releases/lib/config";
import { logger } from "@buildinternet/releases-lib/logger";
import { getAnthropicClient } from "../ai/client.js";
import {
  checkContentHash,
  recordContentHash,
  findOrg,
  getPlaybookForOrg,
} from "../db/queries.js";
import { updateSourceMeta as updateSourceMetaLocal } from "./feed.js";
import { logUsage } from "../lib/usage.js";
import { extractNotesFromLegacyPlaybook } from "../ai/playbook.js";

const localRepo: ExtractRepo = {
  async peekContentHash(source, hash) {
    return checkContentHash(source, hash);
  },
  async commitContentHash(source, hash) {
    await recordContentHash(source, hash);
  },
  async updateSourceMeta(source, patch) {
    // `updateSourceMetaLocal` takes a typed SourceMetadata Partial. The package
    // passes a generic Record<string, unknown>; pass through — runtime is JSON.
    await updateSourceMetaLocal(source, patch as Parameters<typeof updateSourceMetaLocal>[1]);
  },
  async getOrgPlaybook(orgId) {
    if (!orgId) return null;
    const org = await findOrg(orgId);
    if (!org) return null;
    const playbook = await getPlaybookForOrg(org.id, org.slug);
    if (!playbook) return null;
    const notes = playbook.notes ?? extractNotesFromLegacyPlaybook(playbook.content);
    return notes && notes.trim().length > 0 ? notes : null;
  },
  async logUsage(entry) {
    await logUsage(entry);
  },
};

export function buildLocalExtractDeps(): ExtractDeps {
  const apiKey = config.anthropicApiKey();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY must be set to use extract strategies.");
  }

  const cfAccountId = config.cloudflareAccountId();
  const cfApiToken = config.cloudflareApiToken();
  const cloudflare = cfAccountId && cfApiToken
    ? { accountId: cfAccountId, apiToken: cfApiToken }
    : null;

  return {
    anthropicClient: getAnthropicClient(),
    agentModel: config.agentModel(),
    logger,
    cloudflare,
    repo: localRepo,
  };
}

/** Convenience: resolve the current source's playbook context (if any) and
 *  bundle it with the per-source parseInstructions for a strategy call. */
export async function loadGuidance(source: Source, parseInstructions?: string) {
  const playbookContext = (await localRepo.getOrgPlaybook(source.orgId)) ?? undefined;
  return { parseInstructions, playbookContext };
}
