import { Command } from "commander";
import chalk from "chalk";
import { runDiscovery, type DiscoveryState, type DiscoveryOptions } from "../../agent/released.js";
import { isRemoteMode } from "../../lib/mode.js";
import { logger } from "../../lib/logger.js";
import { registerOnboardApplyCommand } from "./onboard-apply.js";
import { runManagedDiscovery } from "../../agent/managed-discovery.js";

interface OnboardOpts {
  domain?: string;
  githubOrg?: string;
  json?: boolean;
  remote?: boolean;
  local?: boolean;
  managedAgents?: boolean;
  sandbox?: boolean;
}

type DiscoveryEngine = "managed-agents" | "sandbox";

/** Resolve which discovery engine to use. Explicit flags > env var > default. */
function resolveDiscoveryEngine(opts: OnboardOpts): DiscoveryEngine {
  if (opts.managedAgents) return "managed-agents";
  if (opts.sandbox) return "sandbox";
  const env = process.env.RELEASED_DISCOVERY_ENGINE?.toLowerCase();
  if (env === "sandbox") return "sandbox";
  return "managed-agents"; // default
}

function shouldUseRemote(opts: OnboardOpts): boolean {
  if (opts.local) return false;
  if (opts.remote) return true;
  return isRemoteMode();
}

export function registerOnboardCommand(program: Command) {
  const onboard = program
    .command("onboard")
    .description("Discover and onboard changelog sources for a company using AI agent")
    .argument("<company>", "Company or product name to discover sources for")
    .option("--domain <domain>", "Seed the agent with the company's domain")
    .option("--github-org <org>", "Seed the agent with the company's GitHub organization")
    .option("--remote", "Run discovery on the remote worker (default when RELEASED_API_URL is set)")
    .option("--local", "Run discovery locally even when remote mode is configured")
    .option("--managed-agents", "Use the managed-agents discovery engine (default)")
    .option("--sandbox", "Use the legacy sandbox discovery engine")
    .option("--json", "Output results as JSON")
    .addHelpText("after", `
Engine selection (RELEASED_DISCOVERY_ENGINE env var, default: managed-agents):
  releases onboard "Acme"                   # uses managed agents (default)
  releases onboard "Acme" --sandbox         # uses the sandbox engine
  RELEASED_DISCOVERY_ENGINE=sandbox releases onboard "Acme"

Examples:
  releases onboard "Vercel"
  releases onboard "Stripe" --domain stripe.com --github-org stripe
  releases onboard "Acme" --remote
  releases onboard "Acme" --local --json`)
    .action(async (company: string, opts: OnboardOpts) => {
      if (opts.remote && opts.local) {
        logger.error("Cannot specify both --remote and --local");
        process.exit(1);
      }

      if (opts.managedAgents && opts.sandbox) {
        logger.error("Cannot specify both --managed-agents and --sandbox");
        process.exit(1);
      }

      const engine = resolveDiscoveryEngine(opts);

      if (engine === "managed-agents" && !shouldUseRemote(opts)) {
        await runManagedAgentsDiscovery(company, opts);
      } else if (shouldUseRemote(opts)) {
        await runRemoteDiscovery(company, opts, engine);
      } else {
        await runLocalDiscovery(company, opts);
      }
    });

  registerOnboardApplyCommand(onboard);
}

async function runDiscoveryWithUI(
  company: string,
  opts: OnboardOpts,
  label: string,
  discoveryFn: (o: DiscoveryOptions) => Promise<DiscoveryState>,
  toolDisplayName: string,
  toolPrefix: string,
): Promise<void> {
  if (!opts.json) {
    process.stderr.write(
      chalk.bold(`Onboarding "${company}"`) + chalk.gray(` — ${label}...\n\n`),
    );
  }

  let lastToolName = "";

  const state = await discoveryFn({
    company,
    domain: opts.domain,
    githubOrg: opts.githubOrg,
    onProgress: opts.json ? undefined : (text) => {
      process.stderr.write(chalk.dim(text));
    },
    onToolUse: opts.json ? undefined : (toolName, command) => {
      if (toolName === toolDisplayName && command) {
        const display = command.length > 120 ? command.slice(0, 117) + "..." : command;
        process.stderr.write(chalk.gray(`  $ ${toolPrefix}${display}\n`));
      } else if (toolName !== lastToolName) {
        process.stderr.write(chalk.gray(`  [${toolName}]\n`));
      }
      lastToolName = toolName;
    },
  });

  if (opts.json) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  printSummary(state);
}

async function runLocalDiscovery(company: string, opts: OnboardOpts): Promise<void> {
  return runDiscoveryWithUI(company, opts, "discovery agent is running locally", runDiscovery, "Bash", "");
}

async function runManagedAgentsDiscovery(company: string, opts: OnboardOpts): Promise<void> {
  return runDiscoveryWithUI(company, opts, "using Anthropic Managed Agents", runManagedDiscovery, "", "");
}

async function runRemoteDiscovery(company: string, opts: OnboardOpts, engine: DiscoveryEngine = "managed-agents"): Promise<void> {
  const apiUrl = process.env.RELEASED_API_URL;
  if (!apiUrl) {
    logger.error("RELEASED_API_URL is not set. Required for remote discovery.");
    process.exit(1);
  }

  const apiKey = process.env.RELEASED_API_KEY;
  if (!apiKey) {
    logger.error("RELEASED_API_KEY is required for remote discovery.");
    process.exit(1);
  }

  const baseUrl = apiUrl.replace(/\/$/, "");

  async function discoveryFetch<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}/v1${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ message: res.statusText }));
      const msg = (body as { message?: string; error?: string }).message
        ?? (body as { error?: string }).error
        ?? res.statusText;
      throw new Error(`Discovery API error (${res.status}): ${msg}`);
    }
    return res.json();
  }

  if (!opts.json) {
    process.stderr.write(
      chalk.bold(`Onboarding "${company}"`) +
        chalk.gray(` — starting remote discovery on ${baseUrl}...\n\n`),
    );
  }

  let sessionId: string;
  try {
    const result = await discoveryFetch<{ sessionId: string }>("/discover", {
      method: "POST",
      body: JSON.stringify({ company, domain: opts.domain, githubOrg: opts.githubOrg, engine }),
    });
    sessionId = result.sessionId;
  } catch (err) {
    logger.error(`Failed to start remote discovery: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (!opts.json) {
    process.stderr.write(chalk.gray(`  Session: ${sessionId}\n`));
  }

  const POLL_INTERVAL = 5_000;
  const MAX_POLL_TIME = 15 * 60 * 1000;
  const startTime = Date.now();
  let lastStep = "";

  while (Date.now() - startTime < MAX_POLL_TIME) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));

    let status: {
      status: "running" | "complete" | "error" | "idle";
      progress?: { step: string; sourcesFound: number; sourcesValidated: number; currentAction: string };
      result?: object;
      error?: string;
    };
    try {
      status = await discoveryFetch(`/discover/${sessionId}`);
    } catch (err) {
      logger.error(`Failed to poll status: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    if (status.status === "complete") {
      if (!opts.json) {
        process.stderr.write(chalk.green("\n  Discovery complete.\n"));
      }

      if (status.result) {
        if (opts.json) {
          console.log(JSON.stringify(status.result, null, 2));
          return;
        }

        const result = status.result as Record<string, unknown>;
        if (result.sources && Array.isArray(result.sources)) {
          printSummary(result as unknown as DiscoveryState);
        } else {
          // Result is a progress object (state file wasn't available)
          const found = result.sourcesFound ?? 0;
          const validated = result.sourcesValidated ?? 0;
          process.stderr.write(
            chalk.gray(`  ${found} source(s) found, ${validated} validated\n`),
          );
          process.stderr.write(
            chalk.dim("  Full results not available — check the status dashboard for details.\n"),
          );
        }
      }
      return;
    }

    if (status.status === "error") {
      logger.error(`Remote discovery failed: ${status.error ?? "Unknown error"}`);
      process.exit(1);
    }

    // Show progress
    if (!opts.json && status.progress) {
      const { step, sourcesFound, sourcesValidated, currentAction } = status.progress;
      if (step !== lastStep) {
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        process.stderr.write(
          chalk.gray(`  [${elapsed}s] `) +
            chalk.dim(`${step}`) +
            chalk.gray(` — ${sourcesFound} found, ${sourcesValidated} validated`) +
            (currentAction ? chalk.dim(` — ${currentAction}`) : "") +
            "\n",
        );
        lastStep = step;
      }
    }
  }

  logger.error("Remote discovery timed out after 15 minutes.");
  process.exit(1);
}

function printSummary(state: DiscoveryState): void {
  const { sources } = state;
  const write = (s: string) => process.stderr.write(s + "\n");

  write("");
  write(chalk.bold(`Discovery results for ${state.product}`));
  write("");

  if (state.domain) write(chalk.gray(`  Domain: ${state.domain}`));
  if (state.githubOrg) write(chalk.gray(`  GitHub: ${state.githubOrg}`));

  if (sources.length === 0) {
    write(chalk.yellow("\n  No sources discovered."));
    return;
  }

  const validated = sources.filter((s) => s.validated);
  const failed = sources.filter((s) => s.validationError);

  write(
    chalk.gray(
      `  ${sources.length} source(s) found, ${validated.length} validated, ${failed.length} failed`,
    ),
  );
  write("");

  for (const s of sources) {
    const conf =
      s.confidence === "high"
        ? chalk.green(s.confidence)
        : s.confidence === "medium"
          ? chalk.yellow(s.confidence)
          : chalk.red(s.confidence);
    const status = s.validationError
      ? chalk.red("failed")
      : s.validated
        ? chalk.green(`${s.releaseCount ?? 0} releases`)
        : chalk.gray("not validated");
    const dup = s.duplicateOf ? chalk.dim(` (dup of ${s.duplicateOf})`) : "";

    write(`  ${chalk.cyan(s.slug)} ${chalk.dim(s.type)} ${conf} — ${status}${dup}`);
    write(chalk.dim(`    ${s.url}`));
  }

  write(chalk.dim(`\n  Status: ${state.status}`));
}
