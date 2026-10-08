/**
 * Uniform dry-run marker for `--json` output.
 *
 * Mutating commands each emit their own preview shape under `--dry-run --json`
 * (`status: "would-add"`, `wouldUpdate: <slug>`, `wouldPost: …`, …). That made
 * "was this a write or just a preview?" un-answerable for an agent without
 * per-command knowledge. `markDryRun` stamps a uniform `dryRun: true` onto any
 * preview payload — additively, so the command's existing fields are preserved
 * — giving callers one reliable signal to branch on across every command.
 *
 * Use it at every `--json` dry-run write site; for an array preview, map it
 * over the elements so each row carries the marker.
 */
export function markDryRun<T extends object>(payload: T): T & { dryRun: true } {
  return { ...payload, dryRun: true };
}
