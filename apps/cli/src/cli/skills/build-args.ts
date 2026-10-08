export const SKILLS_SOURCE = "buildinternet/releases";

export interface InstallOptions {
  skills?: string[];
  global?: boolean;
  agent?: string;
  copy?: boolean;
  list?: boolean;
  yes?: boolean;
  /** Extra args forwarded verbatim after our explicit flags. */
  passthrough?: string[];
}

export function buildSkillsArgs(opts: InstallOptions): string[] {
  const args = ["--yes", "skills", "add", SKILLS_SOURCE];

  for (const skill of opts.skills ?? []) {
    args.push("--skill", skill);
  }
  if (opts.yes !== false) args.push("--yes");
  if (opts.global) args.push("--global");
  if (opts.agent) args.push("--agent", opts.agent);
  if (opts.copy) args.push("--copy");
  if (opts.list) args.push("--list");
  if (opts.passthrough && opts.passthrough.length > 0) args.push(...opts.passthrough);

  return args;
}
