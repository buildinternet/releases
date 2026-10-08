import type { Command } from "commander";

export interface CommandSpec {
  name: string;
  description: string;
  options: Array<{ flags: string[]; description: string }>;
  children: CommandSpec[];
}

export function commandToSpec(cmd: Command): CommandSpec {
  return {
    name: cmd.name(),
    description: cmd.description() ?? "",
    options: cmd.options
      .filter((o) => !o.hidden)
      .map((o) => ({
        flags: [o.short, o.long].filter((f): f is string => Boolean(f)),
        description: o.description ?? "",
      })),
    children: cmd.commands.map(commandToSpec),
  };
}

interface PathNode {
  path: string;
  node: CommandSpec;
}

function walkPaths(root: CommandSpec): PathNode[] {
  const out: PathNode[] = [];
  const visit = (node: CommandSpec, path: string[]) => {
    if (node.children.length > 0) out.push({ path: path.join(" "), node });
    for (const child of node.children) visit(child, [...path, child.name]);
  };
  visit(root, []);
  return out;
}

function bashEscape(s: string): string {
  return s.replace(/"/g, '\\"');
}

function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function fishEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function generateBashCompletion(root: CommandSpec): string {
  const paths = walkPaths(root);
  const programName = root.name;

  const cases = paths
    .map(({ path, node }) => {
      const cmds = node.children.map((c) => c.name).join(" ");
      return `    "${bashEscape(path)}") completions="${cmds}" ;;`;
    })
    .join("\n");

  return `# bash completion for ${programName}
_${programName}() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local path=""
  local i
  for (( i=1; i<COMP_CWORD; i++ )); do
    local w="\${COMP_WORDS[i]}"
    if [[ "$w" != -* ]]; then
      [[ -n "$path" ]] && path+=" "
      path+="$w"
    fi
  done

  local completions=""
  case "$path" in
${cases}
  esac

  if [[ -n "$completions" ]]; then
    COMPREPLY=( $(compgen -W "$completions" -- "$cur") )
  fi
  return 0
}
complete -F _${programName} ${programName}
`;
}

export function generateZshCompletion(root: CommandSpec): string {
  const paths = walkPaths(root);
  const programName = root.name;

  const cases = paths
    .map(({ path, node }) => {
      const entries = node.children
        .map((c) => `      ${shellSingleQuote(`${c.name}:${c.description}`)}`)
        .join("\n");
      return `    "${path}")\n      completions=(\n${entries}\n      )\n      ;;`;
    })
    .join("\n");

  return `#compdef ${programName}
# zsh completion for ${programName}
_${programName}() {
  local path_str=""
  local -a completions
  local i
  for (( i=2; i<CURRENT; i++ )); do
    local w="\${words[i]}"
    if [[ "$w" != -* ]]; then
      [[ -n "$path_str" ]] && path_str+=" "
      path_str+="$w"
    fi
  done

  case "$path_str" in
${cases}
  esac

  if (( \${#completions[@]} > 0 )); then
    _describe '${programName}' completions
  fi
}
compdef _${programName} ${programName}
`;
}

export function generateFishCompletion(root: CommandSpec): string {
  const programName = root.name;
  const lines: string[] = [`# fish completion for ${programName}`];

  function emit(node: CommandSpec, ancestorNames: string[]) {
    for (const child of node.children) {
      const condition =
        ancestorNames.length === 0
          ? "__fish_use_subcommand"
          : ancestorNames.map((a) => `__fish_seen_subcommand_from ${a}`).join("; and ");
      const desc = child.description ? ` -d '${fishEscape(child.description)}'` : "";
      lines.push(`complete -c ${programName} -n '${condition}' -a '${child.name}'${desc}`);
      emit(child, [...ancestorNames, child.name]);
    }
  }

  emit(root, []);
  return lines.join("\n") + "\n";
}

export const SUPPORTED_SHELLS = ["bash", "zsh", "fish"] as const;
export type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

export function isSupportedShell(s: string): s is SupportedShell {
  return (SUPPORTED_SHELLS as readonly string[]).includes(s);
}

export function generateCompletion(shell: SupportedShell, spec: CommandSpec): string {
  switch (shell) {
    case "bash":
      return generateBashCompletion(spec);
    case "zsh":
      return generateZshCompletion(spec);
    case "fish":
      return generateFishCompletion(spec);
  }
}
