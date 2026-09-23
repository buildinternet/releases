import { Fragment } from "react";

/**
 * Lightweight syntax highlighting for the short, known shell commands shown in
 * the click-to-copy install chips (npm/brew/curl/npx/plugin lines plus bare
 * URLs). Deliberately bespoke rather than Shiki: these are one-liners on a
 * marketing surface, and pulling the full highlighter into a client bundle to
 * color a handful of tokens isn't worth the weight. Pure string parsing, so it
 * renders identically on server and client — no hydration mismatch.
 *
 * Token roles:
 *   - command   the executable in a command position (first token, or the
 *               token after a pipe/`;`/`&&`) — e.g. `npm`, `curl`, `/plugin`
 *   - flag      `-g`, `-fsSL`, `--save-dev`
 *   - url       `https://…` (also covers the bare MCP-URL tab)
 *   - operator  `|`, `&&`, `;`, `>` …
 *   - arg       everything else (subcommands, package coordinates) — inherits
 *               the surrounding `<code>` color so plain text stays neutral
 */

const OPERATORS = new Set(["|", "||", "&&", ";", ">", ">>", "<", "&"]);

const TOKEN_CLASS = {
  command: "text-emerald-600 dark:text-emerald-400",
  flag: "text-amber-600 dark:text-amber-400",
  url: "text-sky-600 dark:text-sky-400",
  operator: "text-stone-400 dark:text-stone-500",
  arg: "",
} as const;

type Role = keyof typeof TOKEN_CLASS;

function classify(token: string, inCommandPosition: boolean): Role {
  if (OPERATORS.has(token)) return "operator";
  if (/^https?:\/\//.test(token)) return "url";
  if (token.startsWith("-")) return "flag";
  if (inCommandPosition) return "command";
  return "arg";
}

export function CommandSyntax({ command }: { command: string }) {
  const tokens = command.split(" ");
  let commandPositionPending = true;

  return (
    <>
      {tokens.map((token, i) => {
        // Preserve the empty-string artifacts from collapsed/leading spaces by
        // emitting the separator but skipping classification.
        if (token === "") {
          return <Fragment key={i}>{i > 0 ? " " : ""}</Fragment>;
        }
        const role = classify(token, commandPositionPending);
        // The next token starts a fresh command only after a control operator;
        // any real token consumes the pending command slot.
        commandPositionPending = role === "operator";
        const cls = TOKEN_CLASS[role];
        return (
          <Fragment key={i}>
            {i > 0 ? " " : ""}
            {cls ? <span className={cls}>{token}</span> : token}
          </Fragment>
        );
      })}
    </>
  );
}
