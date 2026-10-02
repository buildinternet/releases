import type { ListingSetupStep } from "@buildinternet/releases-api-types";

/**
 * The steps that follow a `publish: "push"` locator. Shared by listing
 * validate so the preview and the docs describe the same sequence: prove the
 * domain, mint a publish token, add the Action pointed at `path`.
 */
export function pushPublishSetupSteps(location: {
  github?: string;
  path?: string;
}): ListingSetupStep[] {
  const repo = location.github && location.github !== "self" ? location.github : "the repository";
  const path = location.path ?? "CHANGELOG.md";
  const input = path.includes("*") ? "changelog-glob" : "changelog-path";
  return [
    {
      id: "verify",
      title: "Verify domain ownership",
      detail:
        "Sign in and prove you control the domain with a well-known file or a DNS TXT record. A push-fed source is created only after that claim is verified.",
    },
    {
      id: "token",
      title: "Mint a publish token",
      detail:
        "Once the source is tracked, open Account → Webhooks & API and create a publish token for it. Store the token as the RELEASES_API_TOKEN repository secret.",
    },
    {
      id: "action",
      title: "Add the GitHub Action",
      detail: `In ${repo}, add the publish-changelog Action and set ${input} to ${path}. Each push of that changelog updates this source; we do not poll it.`,
    },
  ];
}
