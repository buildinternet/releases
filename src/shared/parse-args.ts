/**
 * Shell-style argument tokenizer.
 *
 * Splits a command string into an argv array, respecting single and double
 * quotes and basic backslash escapes. This prevents multi-word values like
 * `--description "A platform for ..."` from being split on whitespace.
 */
export function parseArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escape = false;
  let inToken = false; // true once we've seen a quote or non-whitespace char

  for (const ch of input) {
    if (escape) {
      current += ch;
      escape = false;
      inToken = true;
      continue;
    }

    if (ch === "\\") {
      escape = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (inToken) {
        args.push(current);
        current = "";
        inToken = false;
      }
      continue;
    }

    current += ch;
    inToken = true;
  }

  if (inToken) {
    args.push(current);
  }

  return args;
}
