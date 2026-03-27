import { runDiscovery } from "./discovery.js";

const PROGRESS_FILE = "/tmp/discovery-progress.json";
const STATE_FILE = "/tmp/discovery-state.json";
const THROTTLE_MS = 5_000;

// Best-effort WebSocket connection to sandbox log server (port 8081).
// NOTE: This connects at module load time. In the sandbox container, sandbox-ws.ts
// must be started first (see discovery-session.ts launchProcess). If the WS server
// isn't up yet when this connects, the onerror handler nulls the socket and we
// fall back to file-based polling. A short startup delay in launchProcess may help.
let logSocket: WebSocket | null = null;
try {
  logSocket = new WebSocket("ws://localhost:8081");
  logSocket.onopen = () => console.error("[discovery] Connected to log socket");
  logSocket.onerror = () => { logSocket = null; };
} catch { /* WS not available — file-based polling still works */ }

function emitLog(line: string): void {
  if (logSocket?.readyState === WebSocket.OPEN) {
    logSocket.send(JSON.stringify({ logLine: line, timestamp: Date.now() }));
  }
}

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

type ErrorCategory = "provider" | "config" | "app";

const PROVIDER_PATTERNS = [
  /credit balance/i,
  /rate limit/i,
  /quota/i,
  /billing/i,
  /insufficient.*(funds|credits|balance)/i,
  /api key.*(invalid|expired|revoked)/i,
  /authentication.*failed/i,
  /unauthorized/i,
  /overloaded/i,
  /503/,
  /529/,
];

const CONFIG_PATTERNS = [
  /ANTHROPIC_API_KEY.*required/i,
  /missing.*key/i,
  /not configured/i,
  /ECONNREFUSED/i,
];

function classifyError(message: string): ErrorCategory {
  if (PROVIDER_PATTERNS.some((p) => p.test(message))) return "provider";
  if (CONFIG_PATTERNS.some((p) => p.test(message))) return "config";
  return "app";
}

async function writeErrorState(
  opts: { company: string; domain?: string; githubOrg?: string },
  error?: string,
  errorCategory?: ErrorCategory,
): Promise<void> {
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
    errorCategory: errorCategory ?? "app",
  };
  await Bun.write(STATE_FILE, JSON.stringify(state, null, 2));
  console.error(`[${state.errorCategory}] Discovery failed: ${error ?? "unknown error"}`);
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

        // Emit first sentence as a log line
        const firstLine = text.split(/[.\n]/)[0]?.trim();
        if (firstLine && firstLine.length > 5 && firstLine.length < 150) {
          emitLog(firstLine);
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

          // Emit granular log lines for CLI commands
          const shortCmd = command.length > 120 ? command.slice(0, 120) + "..." : command;
          emitLog(`$ ${shortCmd}`);

          // Structured events for key milestones
          const addMatch = command.match(/source\s+add\s+\S+\s+(\S+)/);
          if (addMatch) emitLog(`Added source: ${addMatch[1]}`);

          if (command.includes("fetch") && command.includes("dry-run")) {
            const slug = command.match(/fetch\s+(\S+)/)?.[1];
            if (slug) emitLog(`Validating: ${slug}`);
          }

          if (command.includes("source") && command.includes("remove")) {
            const slug = command.match(/remove\s+(\S+)/)?.[1];
            if (slug) emitLog(`Removed: ${slug}`);
          }
        } else if (toolName === "WebSearch") {
          emitLog("Searching web...");
        } else if (toolName === "WebFetch") {
          emitLog("Fetching URL...");
        } else if (toolName === "Agent") {
          emitLog("Delegating to source-validator");
        }
      },
    });

    progress.step = "complete";
    progress.currentAction = "Discovery complete";
    await writeProgress(progress);
    logSocket?.close();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const category = classifyError(message);
    emitLog(`[${category}] ${message}`);
    await writeErrorState({ company, domain, githubOrg }, message, category);
    logSocket?.close();
    process.exit(1);
  }
}

main();
