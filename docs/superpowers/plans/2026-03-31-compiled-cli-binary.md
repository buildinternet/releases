# Compiled CLI Binary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the Released CLI as a self-contained compiled binary so the sandbox container no longer needs the full source tree, Bun runtime, or node_modules.

**Architecture:** Use `bun build --compile` to produce a single executable that embeds the Bun runtime. The agent references the binary by name (`released`) instead of constructing source paths. Agent skills are resolved from a conventional filesystem path with env var override.

**Tech Stack:** Bun compile, existing TypeScript CLI (Commander), Cloudflare sandbox container

**Spec:** `docs/superpowers/specs/2026-03-31-compiled-cli-binary-design.md`

---

### Task 1: Update build scripts in package.json

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Replace the build script and add build:linux**

In `package.json`, replace the existing `"build"` script and add `"build:linux"`:

```json
"build": "bun build --compile src/index.ts --outfile dist/released",
"build:linux": "bun build --compile src/index.ts --outfile dist/released --target=bun-linux-x64",
"build:mcp-browser": "bun build --compile src/agent/mcp-cloudflare-browser.ts --outfile dist/released-mcp-browser",
"build:mcp-browser:linux": "bun build --compile src/agent/mcp-cloudflare-browser.ts --outfile dist/released-mcp-browser --target=bun-linux-x64",
"build:all": "bun run build && bun run build:mcp-browser",
"build:all:linux": "bun run build:linux && bun run build:mcp-browser:linux",
```

- [ ] **Step 2: Verify dist/ is already in .gitignore**

Run: `grep '^dist' .gitignore`
Expected: `dist` is listed (it is — line 3 of current `.gitignore`)

- [ ] **Step 3: Test the build compiles successfully**

Run: `bun run build`
Expected: `dist/released` binary is created with no errors.

Run: `bun run build:mcp-browser`
Expected: `dist/released-mcp-browser` binary is created with no errors.

- [ ] **Step 4: Verify the binary runs**

Run: `./dist/released --help`
Expected: Shows the CLI help output (same as `bun src/index.ts --help`).

Run: `./dist/released --version`
Expected: Shows version `0.1.0`.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "feat: add compiled binary build scripts"
```

---

### Task 2: Replace agent CLI path with binary name

**Files:**
- Modify: `src/agent/released.ts`

- [ ] **Step 1: Replace the CLI command construction**

In `src/agent/released.ts`, remove the `projectRoot` and `cliCmd` lines (lines 48-49) and replace with:

```typescript
const cliCmd = process.env.RELEASED_CLI_CMD ?? "released";
```

This uses the binary name on `$PATH` by default. The env var override (`RELEASED_CLI_CMD`) allows local dev to set it to `bun src/index.ts` if needed.

- [ ] **Step 2: Remove the `resolve` import if no longer used**

Check if `resolve` from `"path"` is still used elsewhere in the file. It is — at lines 113, 117, 120, 145, 159. Keep the import.

- [ ] **Step 3: Update the MCP server command to use the compiled binary**

Replace the MCP server configuration block (lines 143-151) — change from running `bun` with the source file to using the compiled binary:

```typescript
if (cfAccountId && cfApiToken) {
  mcpServers["cloudflare-browser"] = {
    type: "stdio",
    command: process.env.RELEASED_MCP_BROWSER_CMD ?? "released-mcp-browser",
    args: [],
    env: {
      CLOUDFLARE_ACCOUNT_ID: cfAccountId,
      CLOUDFLARE_API_TOKEN: cfApiToken,
    },
  };
}
```

- [ ] **Step 4: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/agent/released.ts
git commit -m "feat: agent references compiled binary instead of source paths"
```

---

### Task 3: Replace skills path resolution with conventional paths

**Files:**
- Modify: `src/agent/released.ts`

- [ ] **Step 1: Add a skills directory resolver function**

Replace the existing `ensureSkillsDiscoverable` function (lines 112-123) with:

```typescript
/** Resolve the skills source directory using conventional paths with env override. */
function resolveSkillsDir(): string | null {
  // 1. Explicit override
  const envDir = process.env.RELEASED_SKILLS_DIR;
  if (envDir && existsSync(envDir)) return envDir;

  // 2. Container convention
  const containerDir = "/usr/share/released/skills";
  if (existsSync(containerDir)) return containerDir;

  // 3. Local user convention
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const localDir = resolve(homeDir, ".released/skills");
  if (existsSync(localDir)) return localDir;

  // 4. Dev fallback — source tree (for running via bun src/index.ts)
  const devDir = resolve(import.meta.dir, "skills");
  if (existsSync(devDir)) return devDir;

  return null;
}

/** Ensure agent skills are discoverable at .claude/skills/ in cwd. */
function ensureSkillsDiscoverable(): void {
  const cwd = process.cwd();
  const skillsTarget = resolve(cwd, ".claude/skills");
  if (existsSync(skillsTarget)) return;

  const skillsSource = resolveSkillsDir();
  if (!skillsSource) {
    logger.warn("No agent skills directory found — agent will run without skills");
    return;
  }

  mkdirSync(resolve(cwd, ".claude"), { recursive: true });
  symlinkSync(skillsSource, skillsTarget);
  logger.debug(`Symlinked agent skills: ${skillsSource} → ${skillsTarget}`);
}
```

- [ ] **Step 2: Update the `cwd` option in the agent query call**

Replace line 159 (`cwd: projectRoot`) with:

```typescript
cwd: process.cwd(),
```

Since we no longer derive `projectRoot` from source paths, use the actual working directory.

- [ ] **Step 3: Remove the now-unused `projectRoot` constant**

After Tasks 2 and 3, `projectRoot` (formerly line 48) is no longer referenced anywhere. Verify with a search:

Run: `grep -n "projectRoot" src/agent/released.ts`
Expected: No matches.

If clean, the line is already gone from Task 2. If any references remain, update them to use `process.cwd()` or the appropriate resolved path.

- [ ] **Step 4: Clean up unused imports**

Check if `resolve` from `"path"` is still needed. It's used in `resolveSkillsDir` and `ensureSkillsDiscoverable`, so keep it.

- [ ] **Step 5: Verify type-check passes**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/agent/released.ts
git commit -m "feat: resolve agent skills from conventional paths"
```

---

### Task 4: Simplify the Dockerfile

**Files:**
- Modify: `workers/discovery/Dockerfile`

- [ ] **Step 1: Replace the Dockerfile**

Replace the entire contents of `workers/discovery/Dockerfile` with:

```dockerfile
FROM docker.io/cloudflare/sandbox:0.8.0

# Copy compiled binaries
COPY dist/released /usr/local/bin/released
COPY dist/released-mcp-browser /usr/local/bin/released-mcp-browser

# Copy agent skills to conventional path
COPY src/agent/skills/ /usr/share/released/skills/

# Place skills where Agent SDK discovers them
RUN mkdir -p /app/.claude/skills && cp -r /usr/share/released/skills/* /app/.claude/skills/

# Sandbox SDK command timeout — 5 minutes for agent runs
ENV COMMAND_TIMEOUT_MS=300000

# Default data dir
ENV RELEASED_DATA_DIR=/app/data
RUN mkdir -p /app/data

EXPOSE 8081
```

- [ ] **Step 2: Verify the binary was built for Linux**

Run: `bun run build:all:linux`
Expected: `dist/released` and `dist/released-mcp-browser` are created targeting linux-x64.

Run: `file dist/released`
Expected: Shows `ELF 64-bit LSB executable` (Linux binary).

- [ ] **Step 3: Commit**

```bash
git add workers/discovery/Dockerfile
git commit -m "feat: simplified Dockerfile using compiled binary"
```

---

### Task 5: End-to-end verification

- [ ] **Step 1: Verify local dev workflow is unchanged**

Run: `bun src/index.ts --help`
Expected: Same help output as before. Local dev path is unaffected.

- [ ] **Step 2: Verify compiled binary works for common commands**

Run: `./dist/released list --json 2>/dev/null | head -1`
Expected: JSON output or empty array (depends on local DB state). The key is no crash.

Run: `./dist/released --version`
Expected: `0.1.0`

- [ ] **Step 3: Verify type-check passes for the full project**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Final commit if any cleanup needed**

Only commit if there are changes. Otherwise, skip.
