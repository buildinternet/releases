import { mkdirSync, writeFileSync, existsSync } from "fs";
import { dirname, basename } from "path";
import { homedir } from "os";
import type { SupportedShell } from "./generate.js";

type Env = Record<string, string | undefined>;

function resolveHome(env: Env): string {
  const home = env.HOME || homedir();
  if (!home) {
    throw new Error(
      "Cannot resolve home directory: $HOME is unset and os.homedir() returned empty.",
    );
  }
  return home;
}

export function detectShell(env: Env = process.env): SupportedShell | null {
  const shell = env.SHELL;
  if (!shell) return null;
  const name = basename(shell);
  if (name === "zsh") return "zsh";
  if (name === "bash") return "bash";
  if (name === "fish") return "fish";
  return null;
}

export function defaultInstallPath(shell: SupportedShell, env: Env = process.env): string {
  const home = resolveHome(env);
  switch (shell) {
    case "zsh":
      return `${home}/.zsh/completions/_releases`;
    case "bash": {
      const xdgData = env.XDG_DATA_HOME ?? `${home}/.local/share`;
      return `${xdgData}/bash-completion/completions/releases`;
    }
    case "fish": {
      const xdgConfig = env.XDG_CONFIG_HOME ?? `${home}/.config`;
      return `${xdgConfig}/fish/completions/releases.fish`;
    }
  }
}

export function rcSnippet(shell: SupportedShell, path: string): string {
  switch (shell) {
    case "zsh": {
      const dir = dirname(path);
      return [
        "Add the following to ~/.zshrc (if not already present):",
        "",
        `  fpath=(${dir} $fpath)`,
        "  autoload -Uz compinit && compinit",
        "",
        "Then start a new shell or run: exec zsh",
      ].join("\n");
    }
    case "bash":
      return [
        "This path is auto-loaded by bash-completion v2 — no rc change needed.",
        "If completions don't appear, ensure bash-completion is installed:",
        "  brew install bash-completion@2   # macOS",
        "  apt install bash-completion       # Debian/Ubuntu",
        "Then start a new shell.",
      ].join("\n");
    case "fish":
      return "Fish auto-loads files in completions/. Start a new shell to pick it up.";
  }
}

/**
 * Locations a package manager (Homebrew, apt, the system) would drop a
 * `releases` completion file — distinct from the per-user path
 * `defaultInstallPath` writes to. Used to suppress the first-run hint when
 * completions are already wired up by the install method (e.g. `brew install`
 * runs `generate_completions_from_executable`).
 */
export function systemCompletionPaths(shell: SupportedShell, env: Env = process.env): string[] {
  const prefixes = ["/opt/homebrew", "/usr/local", "/usr", "/home/linuxbrew/.linuxbrew"];
  if (env.HOMEBREW_PREFIX) prefixes.unshift(env.HOMEBREW_PREFIX);
  const unique = [...new Set(prefixes)];
  switch (shell) {
    case "zsh":
      return unique.map((p) => `${p}/share/zsh/site-functions/_releases`);
    case "bash":
      return unique
        .flatMap((p) => [
          `${p}/etc/bash_completion.d/releases`,
          `${p}/share/bash-completion/completions/releases`,
        ])
        .concat(["/etc/bash_completion.d/releases"]);
    case "fish":
      return unique.map((p) => `${p}/share/fish/vendor_completions.d/releases.fish`);
  }
}

export function systemCompletionInstalled(shell: SupportedShell, env: Env = process.env): boolean {
  return systemCompletionPaths(shell, env).some((p) => existsSync(p));
}

export interface InstallResult {
  path: string;
  alreadyExisted: boolean;
}

export function writeCompletionFile(path: string, content: string): InstallResult {
  const alreadyExisted = existsSync(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return { path, alreadyExisted };
}
