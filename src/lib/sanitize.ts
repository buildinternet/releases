/**
 * Strip ANSI escape sequences from a string.
 * Prevents terminal escape injection when displaying external content
 * (e.g., release titles, content from changelogs).
 */
const ANSI_RE =
  // eslint-disable-next-line no-control-regex -- ANSI escape stripper requires matching control chars
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}
