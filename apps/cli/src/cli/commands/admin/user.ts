/**
 * `releases admin user …` — manage the Better Auth `user.role` column that
 * governs OAuth scope entitlement (read / curator=write / admin). Thin wrapper
 * over the root-key-gated `/v1/admin/users/role` routes; the admin gate is
 * applied by `gateAdminSubtree` in program.ts. See buildinternet/releases#1484.
 */
import { Command } from "commander";
import chalk from "chalk";
import { logger } from "@buildinternet/releases-lib/logger";
import { writeJson } from "../../../lib/output.js";
import {
  getUserRole,
  setUserRole,
  listUserRoles,
  type UserIdentifier,
} from "../../../api/admin.js";
import { renderTable } from "../../render/table.js";

/** Settable roles — mirrors the API's ROLE_LADDER (the route is authoritative). */
const VALID_ROLES = ["user", "curator", "admin"];

interface IdentifierOpts {
  email?: string;
  userId?: string;
}

/** Resolve exactly one of --email / --user-id, or exit 1 with a clear message. */
function resolveIdentifier(opts: IdentifierOpts): UserIdentifier {
  const hasEmail = typeof opts.email === "string" && opts.email.length > 0;
  const hasUserId = typeof opts.userId === "string" && opts.userId.length > 0;
  if (hasEmail === hasUserId) {
    logger.error("Provide exactly one of --email or --user-id.");
    process.exit(1);
  }
  return hasEmail ? { email: opts.email } : { userId: opts.userId };
}

export function registerUserCommand(program: Command) {
  const user = program.command("user").description("Manage user roles (OAuth scope entitlement)");

  user
    .command("set-role")
    .description("Set a user's role (user | curator | admin); revoke = set to user")
    .option("--email <email>", "Target user email")
    .option("--user-id <id>", "Target user id")
    .requiredOption("--role <role>", "Role to assign: user | curator | admin")
    .option("--json", "Output JSON")
    .action(async (opts: IdentifierOpts & { role: string; json?: boolean }) => {
      if (!VALID_ROLES.includes(opts.role)) {
        logger.error(`Invalid role "${opts.role}". Allowed: ${VALID_ROLES.join(", ")}.`);
        process.exit(1);
      }
      const id = resolveIdentifier(opts);
      const result = await setUserRole(id, opts.role);
      if (opts.json) {
        await writeJson(result);
        return;
      }
      logger.info(
        `${result.email}: ${result.previousRole ?? "(none)"} ${chalk.dim("→")} ${chalk.green(
          result.role,
        )}`,
      );
    });

  user
    .command("get-role")
    .description("Show a user's current role")
    .option("--email <email>", "Target user email")
    .option("--user-id <id>", "Target user id")
    .option("--json", "Output JSON")
    .action(async (opts: IdentifierOpts & { json?: boolean }) => {
      const id = resolveIdentifier(opts);
      const result = await getUserRole(id);
      if (!result) {
        logger.error("User not found.");
        process.exit(1);
      }
      if (opts.json) {
        await writeJson(result);
        return;
      }
      logger.info(`${result.email}: ${result.role ?? chalk.dim("(none → read-only)")}`);
    });

  user
    .command("list-roles")
    .description("List users holding a curator or admin role")
    .option("--json", "Output JSON")
    .action(async (opts: { json?: boolean }) => {
      const users = await listUserRoles();
      if (opts.json) {
        await writeJson({ users });
        return;
      }
      if (users.length === 0) {
        logger.info("No curator/admin users.");
        return;
      }
      console.log(
        renderTable({
          head: [
            { label: "Email", noTruncate: true },
            { label: "Role" },
            { label: "User ID", noTruncate: true },
          ],
          rows: users.map((u) => [u.email, u.role ?? chalk.dim("—"), u.userId]),
        }),
      );
    });
}
