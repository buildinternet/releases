import { existsSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { getDataDir } from "@buildinternet/releases-lib/config";
import { defaultInstallPath, detectShell, systemCompletionInstalled } from "./install.js";
import type { SupportedShell } from "./generate.js";

const HINT_MARKER = "completion-hint-shown";
const TRUTHY_CI_VALUES = new Set(["true", "1", "yes"]);

type Env = Record<string, string | undefined>;

function isTruthyEnvFlag(value: string | undefined): boolean {
  return value !== undefined && TRUTHY_CI_VALUES.has(value.toLowerCase());
}

export interface HintGate {
  isInteractive: boolean;
  hintAlreadyShown: boolean;
  completionFileExists: boolean;
  env: Env;
}

export function shouldShowCompletionHint(gate: HintGate): boolean {
  if (!gate.isInteractive) return false;
  if (gate.hintAlreadyShown) return false;
  if (gate.completionFileExists) return false;
  if (isTruthyEnvFlag(gate.env.RELEASES_NO_COMPLETION_HINT)) return false;
  if (isTruthyEnvFlag(gate.env.CI) || isTruthyEnvFlag(gate.env.GITHUB_ACTIONS)) return false;
  const clientKind = gate.env.RELEASES_CLIENT_KIND ?? gate.env.RELEASED_CLIENT_KIND;
  if (clientKind && clientKind !== "external") {
    return false;
  }
  if (!detectShell(gate.env)) return false;
  return true;
}

export interface NoticeGate {
  shell: SupportedShell | null;
  userCompletionExists: boolean;
  systemCompletionExists: boolean;
  env: Env;
}

/**
 * Whether to show the persistent "completions aren't set up" notice on help
 * surfaces (the `releases` landing and `--help`). Unlike the one-time hint,
 * this has no marker check — it persists every time until completions are
 * detected, then self-resolves. Pure so it can be unit-tested without a TTY or
 * real files.
 */
export function shouldShowCompletionNotice(gate: NoticeGate): boolean {
  if (!gate.shell) return false;
  if (isTruthyEnvFlag(gate.env.RELEASES_NO_COMPLETION_HINT)) return false;
  const clientKind = gate.env.RELEASES_CLIENT_KIND ?? gate.env.RELEASED_CLIENT_KIND;
  if (clientKind && clientKind !== "external") {
    return false;
  }
  if (gate.userCompletionExists) return false;
  if (gate.systemCompletionExists) return false;
  return true;
}

export function completionNoticeLine(shell: SupportedShell): string {
  return `Shell completion isn't set up — run "releases completion install ${shell}"`;
}

/**
 * Plain (unstyled) notice text for help surfaces, or null when completions are
 * already set up / the notice is suppressed. Callers style and TTY-gate it.
 */
export function completionNotice(env: Env = process.env): string | null {
  const shell = detectShell(env);
  if (!shell) return null;
  const show = shouldShowCompletionNotice({
    shell,
    userCompletionExists: existsSync(defaultInstallPath(shell, env)),
    systemCompletionExists: systemCompletionInstalled(shell, env),
    env,
  });
  return show ? completionNoticeLine(shell) : null;
}

function markerPath(): string {
  return join(getDataDir(), HINT_MARKER);
}

export function markCompletionHintShown(): void {
  try {
    writeFileSync(markerPath(), new Date().toISOString(), "utf8");
    chmodSync(markerPath(), 0o600);
  } catch {
    // ignore — hint state is best-effort
  }
}

export function maybeShowCompletionHint(): void {
  // Cheap checks first so non-TTY / disabled invocations skip the filesystem
  // entirely — this runs after every successful CLI command.
  const env = process.env as Env;
  const cheapGate: HintGate = {
    isInteractive: process.stderr.isTTY === true,
    hintAlreadyShown: false,
    completionFileExists: false,
    env,
  };
  if (!shouldShowCompletionHint(cheapGate)) return;

  const shell = detectShell(env);
  if (!shell) return;
  if (existsSync(markerPath())) return;
  if (existsSync(defaultInstallPath(shell, env))) return;
  // Don't nag when the install method already wired up completions (e.g.
  // Homebrew generates them at install time into its own prefix).
  if (systemCompletionInstalled(shell, env)) return;

  process.stderr.write(
    [
      "",
      "\x1b[2mTip: enable shell completion with:\x1b[0m",
      `\x1b[2m  releases completion install ${shell}\x1b[0m`,
      "\x1b[2m(set RELEASES_NO_COMPLETION_HINT=1 to silence)\x1b[0m",
      "",
    ].join("\n") + "\n",
  );
  markCompletionHintShown();
}
