import { runDiscovery } from "./discovery.js";

const PROGRESS_FILE = "/tmp/discovery-progress.json";
const STATE_FILE = "/tmp/discovery-state.json";
const THROTTLE_MS = 5_000;

interface ProgressState {
  step: string;
  sourcesFound: number;
  sourcesValidated: number;
  currentAction: string;
}

function parseArgs(argv: string[]): { company: string; domain?: string; githubOrg?: string } {
  const args = argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: bun run-discovery.ts <company> [--domain <domain>] [--github-org <org>]");
    process.exit(1);
  }

  const company = args[0];
  let domain: string | undefined;
  let githubOrg: string | undefined;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--domain" && args[i + 1]) {
      domain = args[++i];
    } else if (args[i] === "--github-org" && args[i + 1]) {
      githubOrg = args[++i];
    }
  }

  return { company, domain, githubOrg };
}

async function writeProgress(progress: ProgressState): Promise<void> {
  await Bun.write(PROGRESS_FILE, JSON.stringify(progress));
}

async function writeErrorState(opts: { company: string; domain?: string; githubOrg?: string }, error?: string): Promise<void> {
  const now = new Date().toISOString();
  const state = {
    product: opts.company,
    domain: opts.domain,
    githubOrg: opts.githubOrg,
    startedAt: now,
    updatedAt: now,
    status: "error" as const,
    sources: [],
    error: error ?? "unknown error",
  };
  await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
  console.error(`Discovery failed: ${error ?? "unknown error"}`);
}

async function main(): Promise<void> {
  const { company, domain, githubOrg } = parseArgs(process.argv);

  let lastProgressWrite = 0;
  const progress: ProgressState = {
    step: "starting",
    sourcesFound: 0,
    sourcesValidated: 0,
    currentAction: `Starting discovery for ${company}`,
  };

  try {
    await runDiscovery({
      company,
      domain,
      githubOrg,
      onProgress: (text) => {
        progress.currentAction = text.slice(0, 200);
        const now = Date.now();
        if (now - lastProgressWrite >= THROTTLE_MS) {
          lastProgressWrite = now;
          writeProgress(progress).catch(() => {});
        }
      },
      onToolUse: (toolName, command) => {
        if (toolName === "Bash" && command) {
          if (command.includes("discover")) progress.step = "discovering";
          else if (command.includes("add")) {
            progress.step = "adding";
            progress.sourcesFound++;
          }
          else if (command.includes("fetch") && command.includes("dry-run")) {
            progress.step = "validating";
            progress.sourcesValidated++;
          }
        }
      },
    });

    progress.step = "complete";
    progress.currentAction = "Discovery complete";
    await writeProgress(progress);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeErrorState({ company, domain, githubOrg }, message);
    process.exit(1);
  }
}

main();
