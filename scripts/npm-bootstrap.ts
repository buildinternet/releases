/**
 * First publish of a new npm package, run once from a maintainer's machine.
 *
 * npm trusted publishing (OIDC) is configured per package, so a package has to
 * exist on npm before a GitHub workflow can publish it. This publishes the
 * current version with your own npm login, then registers the workflow as the
 * package's trusted publisher. Every later version ships from the workflow.
 *
 *   bun scripts/npm-bootstrap.ts <package-dir> <workflow-file> [--dry-run]
 *   bun run publish:bootstrap:sdk
 *
 * Needs `npm login` first, and npm >= 11.10 for `npm trust`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@buildinternet/releases-lib/logger";

const REPO = "buildinternet/releases";

function npm(args: string[], cwd?: string): boolean {
  return spawnSync("npm", args, { cwd, stdio: "inherit" }).status === 0;
}

function onNpm(name: string): boolean {
  try {
    execFileSync("npm", ["view", name, "name"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const [dir, workflow] = args.filter((a) => a !== "--dry-run");
  if (!dir || !workflow) {
    logger.error("usage: npm-bootstrap.ts <package-dir> <workflow-file> [--dry-run]");
    process.exit(1);
  }

  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    name: string;
    version: string;
    private?: boolean;
  };
  if (pkg.private) {
    logger.error(`${pkg.name} is marked private; remove "private" before publishing it.`);
    process.exit(1);
  }

  if (onNpm(pkg.name)) {
    logger.info(`${pkg.name} is already on npm; skipping the first publish.`);
  } else {
    if (!dryRun && !npm(["whoami"])) {
      logger.error("Not logged in to npm. Run `npm login` and try again.");
      process.exit(1);
    }
    logger.info(`Publishing ${pkg.name}@${pkg.version}${dryRun ? " (dry run)" : ""}`);
    const publish = ["publish", "--access", "public", ...(dryRun ? ["--dry-run"] : [])];
    if (!npm(publish, dir)) process.exit(1);
  }

  if (dryRun) return;
  logger.info(`Registering ${REPO} ${workflow} as the trusted publisher`);
  if (!npm(["trust", "github", pkg.name, "--repo", REPO, "--file", workflow])) {
    logger.error(
      `npm trust failed. Add it by hand at https://www.npmjs.com/package/${pkg.name}/access ` +
        `(GitHub Actions, repository ${REPO}, workflow ${workflow}).`,
    );
    process.exit(1);
  }
}

main();
