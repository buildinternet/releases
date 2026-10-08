/* oxlint-disable no-control-regex -- intentional: matches ANSI escape sequences */
/**
 * Strip ANSI escape sequences from a string.
 * Prevents terminal escape injection when displaying external content
 * (e.g., release titles, content from changelogs).
 */
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}
