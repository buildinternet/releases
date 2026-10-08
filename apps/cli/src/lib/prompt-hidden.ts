import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { PromptReader } from "./confirm.js";

/**
 * Reads a single line from the TTY without echoing keystrokes. Returns null when
 * stdin is not a TTY (so callers fall back to --token / stdin). Mirrors the
 * injectable-reader pattern in confirm.ts.
 */
export const hiddenPromptReader: PromptReader = async (question) => {
  if (!process.stdin.isTTY) return null;
  let muted = false;
  const out = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stderr.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(question, (a) => resolve(a));
      muted = true; // mute echo right after the prompt text is written
    });
    process.stderr.write("\n");
    return answer;
  } finally {
    rl.close();
  }
};
