/**
 * Write a value as pretty-printed JSON to stdout, awaiting drain when the
 * write buffer is full.
 *
 * When stdout is a pipe, Node/Bun's `process.stdout.write` is non-blocking
 * and returns `false` once the internal buffer (~96 KB) fills. `console.log`
 * doesn't await drain, so if the CLI process exits before the kernel pipe
 * buffer has drained, tail bytes are silently dropped. This manifests as
 * truncated JSON when a caller pipes `--json` output into `jq`, `cat`, etc.
 *
 * Always use this helper instead of `console.log(JSON.stringify(...))` for
 * machine-readable output.
 */
export async function writeJson(value: unknown): Promise<void> {
  const out = JSON.stringify(value, null, 2) + "\n";
  if (!process.stdout.write(out)) {
    await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
  }
}

/** Compact single-line JSON (for streaming NDJSON-style output). */
export async function writeJsonLine(value: unknown): Promise<void> {
  const out = JSON.stringify(value) + "\n";
  if (!process.stdout.write(out)) {
    await new Promise<void>((resolve) => process.stdout.once("drain", resolve));
  }
}

/**
 * Process-level handler for a broken stdout pipe. When a downstream reader
 * closes the pipe early — `… | head`, `… | jq | head` — the next stdout write
 * raises EPIPE. Bun surfaces it as an `'error'` event rather than crashing, so
 * without a handler the streaming writers above (`--page-all`, `tail -f --json`)
 * hang forever on a `'drain'` that can never fire. Treat a broken pipe as a
 * clean exit (the consumer read all it wanted); rethrow anything else. Wire up
 * once at startup, before any output: `process.stdout.on("error", handleStdoutPipeError)`.
 */
export function handleStdoutPipeError(err: NodeJS.ErrnoException): void {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
}
