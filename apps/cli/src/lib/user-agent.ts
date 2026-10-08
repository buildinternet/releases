import { VERSION } from "../cli/version.js";

/**
 * Identifies the CLI to api.releases.sh and to any external URLs the CLI
 * probes on the user's behalf (feed checks, update checks). Includes the
 * current CLI version so we can correlate issues with specific releases.
 */
export const RELEASES_CLI_UA = `releases-cli/${VERSION} (+https://releases.sh)`;
