import { createInterface } from "node:readline";

/**
 * Reader function injected into `promptConfirm`. Returns `null` to signal
 * "no interactive input available" — the helper interprets that as a
 * non-confirmation. The default implementation is a TTY-gated `readline`
 * prompt; tests inject a deterministic reader.
 */
export type PromptReader = (question: string) => Promise<string | null>;

/**
 * Default reader: refuses to read from a non-TTY stdin (returns `null`
 * without consuming input). Forces scripted callers to bypass the prompt
 * with an explicit `--yes` flag instead, so a piped `echo` can never
 * silently auto-confirm a destructive cascade.
 */
export const defaultPromptReader: PromptReader = async (question) => {
  if (!process.stdin.isTTY) return null;

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(question, (input) => resolve(input));
    });
  } finally {
    rl.close();
  }
};

/**
 * Prompt the user to type back an exact phrase (e.g. an org slug).
 *
 * Returns `true` only when the user types the expected value verbatim
 * (whitespace around the answer is stripped). Anything else — mismatch or a
 * `null` reader response — returns `false`. The caller decides what to do
 * on a mismatch (typically: abort with a non-zero exit).
 */
export async function promptConfirm(
  question: string,
  expected: string,
  reader: PromptReader = defaultPromptReader,
): Promise<boolean> {
  const answer = await reader(question);
  if (answer === null) return false;
  return answer.trim() === expected;
}
