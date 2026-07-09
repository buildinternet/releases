/**
 * Install the owner-facing skill that writes a valid releases.json.
 * Full GitHub URL + `--skill` (same shape as other single-skill installs from a
 * multi-skill repo — prior art: `npx skills add buildinternet/skills`).
 * Source: monorepo `skills/creating-releases-json/`, not the CLI skill pack.
 */
export const SKILL_INSTALL_CMD =
  "npx skills add https://github.com/buildinternet/releases --skill creating-releases-json";

/** Build the paste-into-agent prompt. Optional domain is filled when the user typed one. */
export function buildAgentPrompt(domain?: string): string {
  const site = domain?.trim() ? domain.trim() : "<your website or domain>";
  return [
    "Create a releases.json manifest for our product so registries and agents can find where we publish release notes.",
    "",
    "1. Install the creating-releases-json skill:",
    `   ${SKILL_INSTALL_CMD}`,
    "2. Follow that skill end-to-end: discover the real places we publish updates (changelog, feed, GitHub Releases, App Store, CHANGELOG file), write a valid v2 manifest, and show me the finished file plus the URL it should be served from (usually https://{domain}/.well-known/releases.json).",
    "3. Only declare locations that actually exist — never invent URLs.",
    "",
    `Our website is: ${site}`,
  ].join("\n");
}
