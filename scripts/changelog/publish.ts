#!/usr/bin/env bun
// On-merge / local publish: thin wrapper around the reusable Action.
// Env: RELEASES_API_KEY (admin scope), BEFORE_SHA (github.event.before),
//      optional RELEASES_API_URL.
import { publishChangelog } from "../../actions/publish-changelog/src/publish.ts";

const SOURCE_ID = "src_LNrMz-rrFa2OD27mBUfaT";

try {
  await publishChangelog({
    RELEASES_API_TOKEN: process.env.RELEASES_API_KEY,
    RELEASES_API_URL: process.env.RELEASES_API_URL,
    RELEASES_SOURCE: SOURCE_ID,
    CHANGELOG_PATH: "CHANGELOG.md",
    BEFORE_SHA: process.env.BEFORE_SHA,
    URL_TEMPLATE: "https://releases.sh/updates/{date}",
    GENERATE_CONTENT: "true",
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
