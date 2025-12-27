#!/usr/bin/env tsx
/**
 * Looper - Long-running autonomous harness
 *
 * Usage:
 *   npx tsx run.ts <project-name> --instruction "Build X"
 *   npx tsx run.ts <project-name> --instruction-file ./spec.txt
 *
 * Options:
 *   --instruction <text>   Project instruction/spec
 *   --instruction-file <f> Path to file containing instruction
 *   --sessions <n>         Number of working sessions (default: 10)
 *   --cpu <cores>          CPU cores (default: 4.0)
 *   --memory <mb>          Memory in MB (default: 16384)
 *   --timeout <secs>       Timeout in seconds (default: 3600)
 *   --parallel <n>         Parallel worker sandboxes (default: 1)
 *   --clean-task-branches  Delete all remote task/* branches before starting (default: on)
 *   --no-clean-task-branches Keep remote task/* branches (disable cleanup)
 *   --continuous           After tasks complete, run a Codex spec audit and continue if new tasks are added
 *   --spec-audit-max-areas <n> Max audit areas/reviewers (default: 10)
 *   --spec-audit-parallelism <n> Max parallel Codex reviewers (default: 3)
 *   --model <model>        Claude model: opus, sonnet (default: opus)
 *   --claude-oauth-file <f> Path to Claude Code OAuth credentials JSON (default: ./.claude-code-credentials.json)
 *
 * Environment:
 *   GITHUB_OWNER           Used to derive repo URL
 *   GITHUB_TOKEN           Required for private repos
 *   ANTHROPIC_API_KEY      Required if OAuth credentials not provided
 */

import "dotenv/config";
import { ModalClient, type Sandbox } from "modal";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { LongRunningHarness, type TaskSpec, type LongRunningHarnessConfig } from "./harness.js";
import { getReadyTasks } from "./scheduler.js";
import { logDebug, logError, logInfo, logWarn } from "./logger.js";

const execFileAsync = promisify(execFile);

interface Config {
  projectName: string;
  instruction: string;
  sessions: number;
  cpu: number;
  memoryMb: number;
  timeoutSecs: number;
  repoUrl: string;
  branch: string;
  model: string;
  githubToken?: string;
  anthropicApiKey?: string;
  claudeOAuthFile?: string;
  claudeOAuthCredentials?: string;
  terminateExisting?: boolean;
  reviewAgent?: "claude" | "codex";
  codexModel?: string;
  codexCredentials?: string;
  parallelWorkers?: number;
  cleanTaskBranches?: boolean;
  prompts?: LongRunningHarnessConfig["prompts"];
  continuous?: boolean;
  specAuditMaxAreas?: number;
  specAuditParallelism?: number;
}

interface WorkerResult {
  taskId: string;
  branch: string;
  exitCode: number;
}

interface WorkerState {
  task: TaskSpec;
  branch: string;
  sandbox: Sandbox;
  slot: number;
  promise: Promise<WorkerResult>;
}

interface ParallelControllerConfig {
  projectName: string;
  projectSpec: string;
  repoUrl: string;
  branch: string;
  model: string;
  workingDir: string;
  parallelWorkers: number;
  stopFilePath: string;
  cleanTaskBranches: boolean;
  prompts?: LongRunningHarnessConfig["prompts"];
  continuous?: boolean;
  specAuditMaxAreas?: number;
  specAuditParallelism?: number;
}

// Detect if running inside Modal sandbox
const IN_MODAL = process.env.__LOOPER_IN_MODAL === "1";
const STOP_FILE_PATH = "/harness/.looper-stop-after-session";
const STALE_BRANCH_MS = 24 * 60 * 60 * 1000;
const HARNESS_STATIC_FILES = new Set(["package.json", "tsconfig.json"]);

// Self-renewal: spawn successor sandbox before 24h timeout
const RENEWAL_AFTER_MS = 23 * 60 * 60 * 1000; // 23 hours

async function main() {
  if (IN_MODAL) {
    await runHarness();
  } else {
    await runInModal();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Modal orchestration (runs locally)
// ─────────────────────────────────────────────────────────────────────────────

/** Simple helper to check if a path exists. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sync OAuth credentials from macOS Keychain if sync-credentials.sh exists.
 * Returns true if sync was attempted (successfully or not), false if script doesn't exist.
 */
async function syncCredentialsIfAvailable(oauthFile: string): Promise<boolean> {
  const syncScript = path.join(process.cwd(), "sync-credentials.sh");
  try {
    await fs.access(syncScript);
    // Script exists, try to run it
    try {
      logInfo("Looper", "Syncing OAuth credentials from Keychain...");
      const result = await execFileAsync("bash", [syncScript, oauthFile], {
        cwd: process.cwd(),
      });
      if (result.stdout) {
        // Filter out just the key messages
        const lines = result.stdout.toString().split("\n");
        for (const line of lines) {
          if (line.includes("Token expires:") || line.includes("Credentials written to:")) {
            logInfo("Looper", line.replace(/^\[sync-credentials\] /, ""));
          }
        }
      }
      return true;
    } catch (err: any) {
      // Script exists but failed - might be missing Keychain entry, that's OK
      const stderr = err?.stderr?.toString() || "";
      if (stderr.includes("Could not find credentials")) {
        logWarn("Looper", "Could not sync credentials from Keychain (not logged in?), using existing file");
      } else {
        logWarn("Looper", "Failed to sync credentials", err);
      }
      return true; // We tried
    }
  } catch {
    // Script doesn't exist, that's fine
    return false;
  }
}

async function runInModal() {
  const config = await parseArgs();

  if (!config.projectName || !config.instruction) {
    printUsage();
    process.exit(1);
  }

  if (!config.repoUrl) {
    console.error("Error: Set GITHUB_OWNER or provide --repo-url\n");
    process.exit(1);
  }

  // Sync credentials if using OAuth and sync script is available
  const oauthFile = config.claudeOAuthFile ?? "./.claude-code-credentials.json";
  if (config.claudeOAuthCredentials || await pathExists(oauthFile)) {
    await syncCredentialsIfAvailable(oauthFile);
    // Re-read credentials after sync
    try {
      config.claudeOAuthCredentials = await fs.readFile(oauthFile, "utf8");
      config.claudeOAuthFile = oauthFile;
      JSON.parse(config.claudeOAuthCredentials);
    } catch (err) {
      if (config.claudeOAuthFile) {
        // Explicit file was provided, fail if we can't read it
        console.error(`Error: Failed to read OAuth credentials from ${config.claudeOAuthFile}:`, err);
        process.exit(1);
      }
      // Default file doesn't exist or invalid, will fall back to API key
    }
  }

  if (!config.anthropicApiKey && !config.claudeOAuthCredentials) {
    console.error("Error: Either ANTHROPIC_API_KEY or --claude-oauth-file is required\n");
    process.exit(1);
  }

  if (config.claudeOAuthCredentials) {
    logInfo("Looper", `Using Claude Code OAuth credentials from ${config.claudeOAuthFile ?? "./.claude-code-credentials.json"}`);
  } else {
    logInfo("Looper", "Using ANTHROPIC_API_KEY for authentication");
  }

  // Load Codex credentials for review (default reviewer)
  if (config.reviewAgent !== "claude") {
    const codexAuthPath = path.join(process.env.HOME ?? "", ".codex", "auth.json");
    try {
      config.codexCredentials = await fs.readFile(codexAuthPath, "utf8");
      JSON.parse(config.codexCredentials); // Validate JSON
      logInfo("Looper", `Using Codex credentials from ${codexAuthPath}`);
    } catch (err) {
      console.error(`Error: Codex review (default) requires auth at ${codexAuthPath}`);
      console.error(`Please run: codex auth login`);
      console.error(`Or use --review-agent claude to use Claude for review`);
      process.exit(1);
    }
  }

  logInfo("Looper", `Project: ${config.projectName}`);
  logInfo("Looper", `Repo: ${config.repoUrl} (branch ${config.branch})`);
  logInfo("Looper", `Model: ${config.model}`);
  logInfo("Looper", `Sessions: ${config.sessions || "unlimited"}`);
  logInfo("Looper", `Parallel workers: ${config.parallelWorkers ?? 1}`);
  logInfo("Looper", `Modal credentials: ${process.env.MODAL_TOKEN_ID ? "available" : "not set"}`);

  const client = new ModalClient();
  const appName = `looper-${config.projectName}`;
  const volumeName = `${config.projectName}-volume`;

  const app = await client.apps.fromName(appName, { createIfMissing: true });
  const volume = await client.volumes.fromName(volumeName, { createIfMissing: true });

  // Check for existing running sandboxes to prevent concurrent runs
  const existingSandboxes: Sandbox[] = [];
  for await (const sb of client.sandboxes.list({ appId: app.appId })) {
    existingSandboxes.push(sb);
  }
  if (existingSandboxes.length > 0) {
    if (config.terminateExisting) {
      logInfo("Looper", `Found ${existingSandboxes.length} running sandbox(es), terminating...`);
      for (const sb of existingSandboxes) {
        logInfo("Looper", `Terminating sandbox: ${sb.sandboxId}`);
        try {
          await sb.terminate();
        } catch (err) {
          logWarn("Looper", `Failed to terminate ${sb.sandboxId}`, err);
        }
      }
      logInfo("Looper", "Existing sandboxes terminated.");
    } else if ((config.parallelWorkers ?? 1) > 1) {
      logWarn("Looper", `Found ${existingSandboxes.length} running sandbox(es); parallel mode will continue.`);
    } else {
      logError("Looper", `ERROR: Found ${existingSandboxes.length} running sandbox(es) for this project:`);
      for (const sb of existingSandboxes) {
        logError("Looper", `  - ${sb.sandboxId}`);
      }
      logError("Looper", "\nConcurrent runs against the same volume will cause conflicts.");
      logError("Looper", "Either wait for the existing run to complete, or use --terminate to stop it.\n");
      process.exit(1);
    }
  }

  const image = buildImage(client);

  const secretEntries: Record<string, string> = {};
  if (config.githubToken) secretEntries.GITHUB_TOKEN = config.githubToken;
  if (config.anthropicApiKey && !config.claudeOAuthCredentials) {
    secretEntries.ANTHROPIC_API_KEY = config.anthropicApiKey;
  }
  if (config.claudeOAuthCredentials) {
    secretEntries.CLAUDE_CODE_CREDENTIALS_JSON = config.claudeOAuthCredentials;
  }
  if (config.codexCredentials) {
    secretEntries.CODEX_CREDENTIALS_JSON = config.codexCredentials;
  }
  // Forward Modal credentials so the working agent can spawn sandboxes
  if (process.env.MODAL_TOKEN_ID) {
    secretEntries.MODAL_TOKEN_ID = process.env.MODAL_TOKEN_ID;
  }
  if (process.env.MODAL_TOKEN_SECRET) {
    secretEntries.MODAL_TOKEN_SECRET = process.env.MODAL_TOKEN_SECRET;
  }

  const secrets = Object.keys(secretEntries).length > 0
    ? [await client.secrets.fromObject(secretEntries)]
    : [];

  const projectDir = `/workspace/${config.projectName}`;

  logInfo("Looper", "Creating sandbox...");
  // Modal defaults to ~10 minutes if no timeout is provided. Treat 0 as "long timeout".
  const timeoutMs =
    config.timeoutSecs > 0
      ? config.timeoutSecs * 1000
      : 24 * 60 * 60 * 1000; // 24h fallback

  const sandbox = await client.sandboxes.create(app, image, {
    cpu: config.cpu,
    memoryMiB: config.memoryMb,
    ...(timeoutMs ? { timeoutMs } : {}),
    idleTimeoutMs: 60 * 1000,
    volumes: { "/workspace": volume },
    env: {
      __LOOPER_IN_MODAL: "1",
      PROJECT_NAME: config.projectName,
      PROJECT_SPEC_FILE: "/harness/spec.txt",
      REPOSITORY_URL: config.repoUrl,
      REPOSITORY_BRANCH: config.branch,
      REPOSITORY_BASE_BRANCH: config.branch,
      WORKSPACE_DIR: projectDir,
      MAX_SESSIONS: String(config.sessions),
      LOOPER_PARALLEL_WORKERS: String(config.parallelWorkers ?? 1),
      LOOPER_CLEAN_TASK_BRANCHES: config.cleanTaskBranches === false ? "0" : "1",
      ...(config.continuous ? { LOOPER_CONTINUOUS: "1" } : {}),
      ...(config.specAuditMaxAreas ? { LOOPER_SPEC_AUDIT_MAX_AREAS: String(config.specAuditMaxAreas) } : {}),
      ...(config.specAuditParallelism ? { LOOPER_SPEC_AUDIT_PARALLELISM: String(config.specAuditParallelism) } : {}),
      MODEL: config.model,
      LOOPER_STOP_FILE: STOP_FILE_PATH,
      // Playwright needs to find the browsers installed during image build
      PLAYWRIGHT_BROWSERS_PATH: "/home/looper/.cache/ms-playwright",
      ...(config.claudeOAuthCredentials ? { CLAUDE_CONFIG_DIR: "/home/looper/.config/claude" } : {}),
      ...(config.reviewAgent ? { REVIEW_AGENT: config.reviewAgent } : {}),
      ...(config.codexModel ? { CODEX_MODEL: config.codexModel } : {}),
      ...(config.prompts ? { LOOPER_PROMPTS_JSON: JSON.stringify(config.prompts) } : {}),
    },
    secrets,
  });

  logInfo("Looper", `Sandbox: ${sandbox.sandboxId}`);

  let sigintCount = 0;
  let sandboxTerminated = false;
  const terminateAllSandboxes = async () => {
    const sandboxes: Sandbox[] = [];
    for await (const sb of client.sandboxes.list({ appId: app.appId })) {
      sandboxes.push(sb);
    }
    if (sandboxes.length === 0) return;
    logInfo("Looper", `Terminating ${sandboxes.length} sandbox(es)...`);
    for (const sb of sandboxes) {
      try {
        await sb.terminate();
      } catch (err) {
        logWarn("Looper", `Failed to terminate ${sb.sandboxId}`, err);
      }
    }
  };

  // Ensure sandbox is terminated on process exit (last resort cleanup)
  const cleanupOnExit = () => {
    if (!sandboxTerminated) {
      logInfo("Looper", "Process exiting, terminating sandbox...");
      sandbox.terminate().catch(() => {});
    }
  };
  process.on("exit", cleanupOnExit);
  process.on("uncaughtException", (err) => {
    logError("Looper", "Uncaught exception", err);
    cleanupOnExit();
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    logError("Looper", "Unhandled rejection", reason);
    cleanupOnExit();
    process.exit(1);
  });

  const handleSigint = () => {
    sigintCount += 1;

    if (sigintCount === 1) {
      logInfo("Looper", "\nCtrl+C received. Will stop after the current session finishes. Press Ctrl+C again to force terminate.");
      void requestGracefulStop(sandbox);
      return;
    }

    if (sigintCount >= 3) {
      logInfo("Looper", "\nForce exit.");
      process.exit(1);
    }

    logInfo("Looper", "\nForcing shutdown and terminating sandbox...");
    sandboxTerminated = true;
    terminateAllSandboxes().then(() => sandbox.terminate()).then(() => {
      process.exit(1);
    }).catch(() => {
      process.exit(1);
    });
    // Fallback: force exit after 3 seconds if terminate hangs
    setTimeout(() => process.exit(1), 3000);
  };

  process.on("SIGINT", handleSigint);

  try {
    await uploadCode(sandbox, config);
    logInfo("Looper", "Checking repo exists...");
    await ensureRepoExists(config);
    logInfo("Looper", "Repo check complete.");

    // Clean up stale .looper cache, git locks, and set up directories
    logInfo("Looper", "Setting up workspace directories...");
    const setupCmd = `sudo rm -rf /workspace/.looper && sudo mkdir -p ${projectDir} /workspace/.looper && sudo chown -R looper:looper ${projectDir} /workspace/.looper && sudo rm -f ${projectDir}/.git/index.lock ${projectDir}/.git/*.lock 2>/dev/null || true`;
    const setupResult = await exec(sandbox, setupCmd, "/harness", { stream: true });
    if (setupResult.exitCode !== 0) {
      throw new Error(`Workspace setup failed with exit code ${setupResult.exitCode}`);
    }
    logInfo("Looper", "Workspace ready. Starting harness...");

    // Add echo to confirm command started, then run tsx
    const cmd = `echo "[Looper] Harness process starting..." && sudo -E -u looper HOME=/home/looper npx tsx run.ts`;

    console.log("─".repeat(60));
    let result: { exitCode: number };
    try {
      result = await exec(sandbox, cmd, "/harness", {
        stream: true,
        mirrorToSandboxLogs: true,
      });
    } catch (execErr) {
      logError("Looper", "Exec failed", execErr);
      result = { exitCode: 1 };
    }
    console.log("─".repeat(60));
    logInfo("Looper", `Harness exited with code ${result.exitCode}`);

    process.exitCode = result.exitCode;
  } finally {
    process.off("SIGINT", handleSigint);
    process.off("exit", cleanupOnExit);

    // Always terminate sandbox, even if other cleanup fails
    const terminateSandbox = async () => {
      if (!sandboxTerminated) {
        logInfo("Looper", "Terminating sandbox...");
        try {
          await sandbox.terminate();
          sandboxTerminated = true;
          logInfo("Looper", "Sandbox terminated.");
        } catch (err) {
          logWarn("Looper", "Failed to terminate sandbox", err);
        }
      }
    };

    try {
      if (config.claudeOAuthCredentials && config.claudeOAuthFile) {
        await syncCredentialsFromSandbox(sandbox, config.claudeOAuthFile);
      }
    } catch (err) {
      logWarn("Looper", "Failed to sync credentials", err);
    }

    await terminateSandbox();
    logInfo("Looper", "Done.");
  }
}

function buildImage(client: ModalClient) {
  // Non-root user required: Claude SDK refuses bypassPermissions as root
  return client.images
    .fromRegistry("node:22-slim")
    .dockerfileCommands([
      // Core tools (general purpose)
      "RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates sudo procps build-essential python3 python3-pip ripgrep && rm -rf /var/lib/apt/lists/*",
      // Go (commonly needed)
      "RUN curl -fsSL https://go.dev/dl/go1.23.4.linux-amd64.tar.gz | tar -C /usr/local -xz",
      "ENV PATH=$PATH:/usr/local/go/bin",
      // Java (for Kafka client interop testing)
      "RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y openjdk-17-jdk maven && rm -rf /var/lib/apt/lists/*",
      "ENV JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64",
      "ENV PATH=$PATH:$JAVA_HOME/bin",
      // Playwright browser dependencies (for MCP browser automation)
      "RUN npx -y playwright@latest install-deps chromium",
      // User setup
      "RUN useradd -m -s /bin/bash looper && echo 'looper ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers",
      "RUN mkdir -p /harness /workspace && chown -R looper:looper /harness /workspace",
      "USER looper",
      "ENV PATH=$PATH:/usr/local/go/bin:/home/looper/go/bin:/home/looper/.cargo/bin",
      // Rust (for krafka and other Rust projects) - installed as looper user
      "RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable",
      // Install Playwright browser binaries as looper user
      "RUN npx -y playwright@latest install chromium",
      // Install OpenAI Codex CLI for code review
      "RUN npm install -g @openai/codex@latest",
      "RUN git config --global user.email 'agent@looper.local' && git config --global user.name 'Looper Agent' && git config --global --add safe.directory '*'",
      "WORKDIR /harness",
    ]);
}

async function uploadCode(sandbox: Sandbox, config: Config) {
  logInfo("Looper", "Uploading code...");

  const files = await listHarnessFiles(process.cwd());
  for (const file of files) {
    const content = await fs.readFile(path.join(process.cwd(), file), "utf8");
    await writeFileToSandbox(sandbox, `/harness/${file}`, content);
  }

  // Write spec file (may be large, so use chunked approach)
  await writeFileToSandbox(sandbox, "/harness/spec.txt", config.instruction);

  logInfo("Looper", "Installing dependencies...");
  const result = await exec(sandbox, "npm install", "/harness", {
    stream: true,
    mirrorToSandboxLogs: true,
  });
  if (result.exitCode !== 0) throw new Error("npm install failed");
}

async function listHarnessFiles(baseDir: string): Promise<string[]> {
  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".ts") || HARNESS_STATIC_FILES.has(entry.name)) {
      files.push(entry.name);
    }
  }
  return files;
}

/**
 * Write a file to the sandbox, handling large files by chunking.
 * Uses heredoc to avoid shell argument length limits.
 */
async function writeFileToSandbox(sandbox: Sandbox, filePath: string, content: string) {
  const b64 = Buffer.from(content).toString("base64");
  
  // For small files, use simple echo
  if (b64.length < 50000) {
    await exec(sandbox, `echo '${b64}' | base64 -d > '${filePath}'`, "/");
    return;
  }

  // For large files, write base64 in chunks then decode
  const chunkSize = 40000; // Safe chunk size for shell
  const tempFile = `${filePath}.b64`;
  
  for (let i = 0; i < b64.length; i += chunkSize) {
    const chunk = b64.slice(i, i + chunkSize);
    const op = i === 0 ? ">" : ">>";
    // Use heredoc to avoid argument length issues
    await exec(sandbox, `cat <<'CHUNK_EOF' ${op} '${tempFile}'\n${chunk}\nCHUNK_EOF`, "/");
  }
  
  await exec(sandbox, `base64 -d '${tempFile}' > '${filePath}' && rm '${tempFile}'`, "/");
}

async function requestGracefulStop(sandbox: Sandbox) {
  try {
    await exec(sandbox, `touch '${STOP_FILE_PATH}'`, "/", {});
    logInfo("Looper", "Requested graceful shutdown after current session.");
  } catch (err) {
    logWarn("Looper", "Failed to signal graceful shutdown", err);
  }
}

async function syncCredentialsFromSandbox(sandbox: Sandbox, localCredentialsFile: string) {
  try {
    const credentialsPath = "/home/looper/.config/claude/.credentials.json";
    const localPath = path.isAbsolute(localCredentialsFile)
      ? localCredentialsFile
      : path.resolve(process.cwd(), localCredentialsFile);
    
    const result = await exec(sandbox, `cat '${credentialsPath}' 2>/dev/null || echo ""`, "/", {});
    
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      logInfo("Looper", "No credentials file found in sandbox to sync.");
      return;
    }

    const sandboxCredentials = result.stdout.trim();
    
    let sandboxParsed: { claudeAiOauth?: { accessToken: string; expiresAt: number } };
    try {
      sandboxParsed = JSON.parse(sandboxCredentials);
      if (!sandboxParsed.claudeAiOauth) {
        logInfo("Looper", "Sandbox credentials file doesn't contain OAuth data.");
        return;
      }
    } catch (err) {
      logWarn("Looper", "Failed to parse sandbox credentials", err);
      return;
    }

    let localParsed: { claudeAiOauth?: { accessToken: string; expiresAt: number } } | null = null;
    try {
      const localContent = await fs.readFile(localPath, "utf8");
      localParsed = JSON.parse(localContent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logWarn("Looper", "Failed to read local credentials", err);
        return;
      }
    }

    const localToken = localParsed?.claudeAiOauth?.accessToken;
    const sandboxToken = sandboxParsed.claudeAiOauth.accessToken;
    const localExpiresAt = localParsed?.claudeAiOauth?.expiresAt;
    const sandboxExpiresAt = sandboxParsed.claudeAiOauth.expiresAt;

    if (localToken !== sandboxToken || (sandboxExpiresAt && sandboxExpiresAt > (localExpiresAt || 0))) {
      await fs.mkdir(path.dirname(localPath), { recursive: true });
      await fs.writeFile(localPath, sandboxCredentials, "utf8");
      logInfo("Looper", `Synced refreshed OAuth credentials to ${localPath}`);
      logInfo("Looper", `Token updated: ${localToken !== sandboxToken ? "YES" : "NO"}, Expires at: ${new Date(sandboxExpiresAt).toISOString()}`);
    } else {
      logInfo("Looper", "OAuth credentials unchanged, no sync needed.");
    }
  } catch (err) {
    logWarn("Looper", "Failed to sync credentials from sandbox", err);
  }
}

async function exec(
  sandbox: Sandbox,
  command: string,
  cwd: string,
  opts: { stream?: boolean; mirrorToSandboxLogs?: boolean } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { stream = false, mirrorToSandboxLogs = false } = opts;

  const commandWithCwd = `cd '${cwd}' && ${command}`;
  const wrappedCommand = mirrorToSandboxLogs
    ? mirrorOutputToSandboxLogs(commandWithCwd)
    : commandWithCwd;

  const proc = await sandbox.exec(["bash", "-lc", wrappedCommand]);

  let stdout = "";
  let stderr = "";

  if (stream) {
    const drain = async (src: AsyncIterable<any>, out: NodeJS.WriteStream, buf: { s: string }) => {
      for await (const chunk of src) {
        const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        buf.s += text;
        out.write(text);
      }
    };
    const stdoutBuf = { s: "" };
    const stderrBuf = { s: "" };
    await Promise.all([
      drain(proc.stdout, process.stdout, stdoutBuf),
      drain(proc.stderr, process.stderr, stderrBuf),
    ]);
    stdout = stdoutBuf.s;
    stderr = stderrBuf.s;
  } else {
    [stdout, stderr] = await Promise.all([proc.stdout.readText(), proc.stderr.readText()]);
  }

  return { exitCode: await proc.wait(), stdout, stderr };
}

/** Mirror stdout/stderr into the sandbox's main PID so Modal UI shows the logs. */
function mirrorOutputToSandboxLogs(command: string): string {
  // /proc/1/fd/{1,2} are the container's stdout/stderr streams that Modal captures.
  return `{ set -o pipefail; ${command}; } > >(tee /proc/1/fd/1) 2> >(tee /proc/1/fd/2 >&2)`;
}

async function ensureRepoExists(config: Config) {
  if (!config.githubToken) return;

  const match = config.repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (!match) return;
  const [, owner, repo] = match;

  const headers = {
    Authorization: `Bearer ${config.githubToken}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "looper",
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

  try {
    const check = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers,
      signal: controller.signal,
    });
    if (check.status === 200) return;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      logWarn("Looper", "GitHub API timeout checking repo, continuing anyway...");
      return;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  const body = JSON.stringify({ name: repo, private: true });
  const orgResp = await fetch(`https://api.github.com/orgs/${owner}/repos`, {
    method: "POST", headers, body,
  });
  if (orgResp.status === 201) return;

  const userResp = await fetch("https://api.github.com/user/repos", {
    method: "POST", headers, body,
  });
  if (userResp.status !== 201) {
    throw new Error(`Failed to create repo: ${await userResp.text()}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Harness execution (runs inside Modal)
// ─────────────────────────────────────────────────────────────────────────────

/** Spawn a successor sandbox before 24h timeout. */
async function scheduleRenewal(stopFilePath: string) {
  // Cache essential harness files to volume for successor (skip node_modules)
  const cacheDir = "/workspace/.looper";
  await fs.mkdir(cacheDir, { recursive: true });
  
  // Determine source directory - could be /harness (initial) or /workspace/.looper (successor)
  const sourceDir = path.dirname(new URL(import.meta.url).pathname);
  
  // Copy only essential files, not node_modules (will reinstall in successor)
  const essentialFiles = [...await listHarnessFiles(sourceDir), "spec.txt"];
  for (const file of essentialFiles) {
    try {
      const srcPath = path.join(sourceDir, file);
      const destPath = path.join(cacheDir, file);
      // Skip if source and destination are the same (running from cache already)
      if (srcPath !== destPath) {
        await fs.copyFile(srcPath, destPath);
      }
    } catch (err) {
      // spec.txt might not exist yet, that's ok
      if (file !== "spec.txt") throw err;
    }
  }
  logInfo("Harness", `Renewal scheduled in ${(RENEWAL_AFTER_MS / 3600000).toFixed(1)}h`);

  setTimeout(async () => {
    logInfo("Harness", "Spawning successor sandbox...");
    try {
      const client = new ModalClient();
      const projectName = process.env.PROJECT_NAME!;
      const app = await client.apps.fromName(`looper-${projectName}`, { createIfMissing: true });
      const volume = await client.volumes.fromName(`${projectName}-volume`, { createIfMissing: true });

      // Filter env to only defined values
      const env = Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)
      );
      env.PROJECT_SPEC_FILE = "/workspace/.looper/spec.txt";

      // Secrets need explicit handling (can't be in env)
      const secretKeys = ["GITHUB_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_CREDENTIALS_JSON", "CODEX_CREDENTIALS_JSON", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"];
      const secretEntries = Object.fromEntries(secretKeys.filter(k => env[k]).map(k => [k, env[k]]));
      const secrets = Object.keys(secretEntries).length ? [await client.secrets.fromObject(secretEntries)] : [];

      const sandbox = await client.sandboxes.create(app, buildImage(client), {
        cpu: 2.0, memoryMiB: 4096, timeoutMs: 24 * 60 * 60 * 1000,
        volumes: { "/workspace": volume }, env, secrets,
      });

      const startCmd = `cd /workspace/.looper && npm install --prefer-offline && sudo -E -u looper HOME=/home/looper npx tsx run.ts`;
      await sandbox.exec(["bash", "-lc", `nohup bash -c '${startCmd}' > /proc/1/fd/1 2>&1 &`]);
      logInfo("Harness", `Successor: ${sandbox.sandboxId}`);
      await fs.writeFile(stopFilePath, "renewal");
    } catch (err) {
      logError("Harness", "Failed to spawn successor", err);
    }
  }, RENEWAL_AFTER_MS);
}

async function runHarness() {
  const projectName = process.env.PROJECT_NAME!;
  const specFile = process.env.PROJECT_SPEC_FILE!;
  const repoUrl = process.env.REPOSITORY_URL!;
  const branch = process.env.REPOSITORY_BRANCH ?? "main";
  const baseBranch = process.env.REPOSITORY_BASE_BRANCH ?? branch;
  const model = process.env.MODEL ?? "sonnet";
  const workingDir = process.env.WORKSPACE_DIR!;
  const maxSessions = parseInt(process.env.MAX_SESSIONS ?? "10", 10);
  const stopFilePath = process.env.LOOPER_STOP_FILE ?? path.join(workingDir, ".looper-stop-after-session");
  const reviewAgent = process.env.REVIEW_AGENT as "claude" | "codex" | undefined;
  const codexModel = process.env.CODEX_MODEL;
  const promptsJson = process.env.LOOPER_PROMPTS_JSON;
  const prompts = promptsJson ? JSON.parse(promptsJson) as LongRunningHarnessConfig["prompts"] : undefined;
  const role = process.env.LOOPER_ROLE ?? "controller";
  const parallelWorkers = parseInt(process.env.LOOPER_PARALLEL_WORKERS ?? "1", 10);
  const cleanTaskBranches = process.env.LOOPER_CLEAN_TASK_BRANCHES !== "0";
  const continuous = process.env.LOOPER_CONTINUOUS === "1";
  const specAuditMaxAreasRaw = parseInt(process.env.LOOPER_SPEC_AUDIT_MAX_AREAS ?? "", 10);
  const specAuditParallelismRaw = parseInt(process.env.LOOPER_SPEC_AUDIT_PARALLELISM ?? "", 10);
  const specAuditMaxAreas = Number.isFinite(specAuditMaxAreasRaw) ? specAuditMaxAreasRaw : undefined;
  const specAuditParallelism = Number.isFinite(specAuditParallelismRaw) ? specAuditParallelismRaw : undefined;
  const workerTaskId = process.env.LOOPER_TASK_ID;
  const workerTaskBranch = process.env.LOOPER_TASK_BRANCH;

  const projectSpec = await fs.readFile(specFile, "utf8");

  const oauthCredentialsJson = process.env.CLAUDE_CODE_CREDENTIALS_JSON;
  if (oauthCredentialsJson) {
    const configDir = "/home/looper/.config/claude";
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const credentialsPath = path.join(configDir, ".credentials.json");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(credentialsPath, oauthCredentialsJson, "utf8");
    delete process.env.ANTHROPIC_API_KEY;
    logInfo("Harness", `Using Claude Code OAuth credentials from ${credentialsPath}`);
  } else if (process.env.ANTHROPIC_API_KEY) {
    logInfo("Harness", "Using ANTHROPIC_API_KEY for authentication");
  } else {
    logWarn("Harness", "Warning: No authentication credentials found (neither OAuth nor ANTHROPIC_API_KEY)");
  }

  // Write Codex credentials if using codex review agent
  const codexCredentialsJson = process.env.CODEX_CREDENTIALS_JSON;
  if (codexCredentialsJson) {
    const codexDir = "/home/looper/.codex";
    const codexAuthPath = path.join(codexDir, "auth.json");
    await fs.mkdir(codexDir, { recursive: true });
    await fs.writeFile(codexAuthPath, codexCredentialsJson, { mode: 0o600 });
    logInfo("Harness", `Using Codex credentials from ${codexAuthPath}`);
  }

  logInfo("Harness", `Project: ${projectName}`);
  logInfo("Harness", `Repo: ${repoUrl} (branch ${branch})`);
  logInfo("Harness", `Model: ${model}`);
  logInfo("Harness", `Sessions: ${maxSessions}`);
  logInfo("Harness", `Review agent: ${reviewAgent ?? "codex"}${codexModel ? ` (model: ${codexModel})` : ""}`);
  logInfo("Harness", `Continuous: ${continuous ? "yes" : "no"}`);
  logInfo("Harness", `Clean task branches: ${cleanTaskBranches ? "yes" : "no"}`);
  if (continuous) {
    logInfo(
      "Harness",
      `Spec audit: maxAreas=${specAuditMaxAreas ?? 10}, parallelism=${specAuditParallelism ?? 3}`
    );
  }

  if (role === "worker") {
    if (!workerTaskId || !workerTaskBranch) {
      throw new Error("Worker mode requires LOOPER_TASK_ID and LOOPER_TASK_BRANCH");
    }

    const workerHarness = new LongRunningHarness({
      workingDir,
      projectSpec,
      projectName,
      model,
      repositoryUrl: repoUrl,
      branch: workerTaskBranch,
      baseBranch,
      gitToken: process.env.GITHUB_TOKEN,
      useProjectSettings: true,
      stopFilePath,
      enableReviewAgent: true,
      maxReviewIterations: 5,
      maxReviewTurns: 100,
      reviewAgent,
      codexModel,
      prompts,
      mcpServers: {
        playwright: {
          command: "npx",
          args: [
            "-y",
            "@playwright/mcp@latest",
            "--browser", "chromium",
            "--headless",
          ],
        },
      },
    });

    const success = await workerHarness.runSingleTask(workerTaskId, true);
    process.exit(success ? 0 : 1);
  }

  await fs.rm(stopFilePath, { force: true });

  // Schedule self-renewal before 24h timeout (also caches harness to volume)
  await scheduleRenewal(stopFilePath);

  if (parallelWorkers > 1) {
    try {
      await runParallelController({
        projectName,
        projectSpec,
        repoUrl,
        branch,
        model,
        workingDir,
        parallelWorkers,
        stopFilePath,
        cleanTaskBranches,
        prompts,
        continuous,
        specAuditMaxAreas,
        specAuditParallelism,
      });
      logInfo("Harness", "Parallel controller completed successfully, exiting.");
      process.exit(0);
    } catch (err) {
      logError("Harness", "Parallel controller failed", err);
      process.exit(1);
    }
  }

  const harness = new LongRunningHarness({
    workingDir,
    projectSpec,
    projectName,
    model,
    repositoryUrl: repoUrl,
    branch,
    baseBranch,
    gitToken: process.env.GITHUB_TOKEN,
    useProjectSettings: true,
    stopFilePath,
    // Review agent ping-pong flow
    enableReviewAgent: true,
    maxReviewIterations: 5,
    maxReviewTurns: 100,
    reviewAgent,
    codexModel,
    prompts,
    continuous,
    specAuditMaxAreas,
    specAuditParallelism,
    // Playwright MCP for browser automation during testing
    // Use the Chromium binary installed in the image (not Chrome, which requires sudo)
    mcpServers: {
      playwright: {
        command: "npx",
        args: [
          "-y",
          "@playwright/mcp@latest",
          "--browser", "chromium",
          "--headless",
        ],
      },
    },
  });

  let sigintCount = 0;
  const handleSigint = async () => {
    sigintCount += 1;
    if (sigintCount === 1) {
      logInfo("Harness", "\nCtrl+C received. Will stop after the current session finishes. Press Ctrl+C again to exit immediately.");
      try {
        await fs.writeFile(stopFilePath, "stop", "utf8");
      } catch (err) {
        logWarn("Harness", "Failed to write stop file", err);
      }
      return;
    }

    logInfo("Harness", "\nExiting immediately due to repeated Ctrl+C.");
    process.exit(1);
  };

  process.on("SIGINT", handleSigint);

  try {
    await harness.runUntilDone(maxSessions);
    logInfo("Harness", "Harness completed successfully, exiting.");
    process.exit(0);
  } catch (err) {
    logError("Harness", "Harness failed", err);
    process.exit(1);
  } finally {
    process.off("SIGINT", handleSigint);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Parallel controller
// ─────────────────────────────────────────────────────────────────────────────

async function runParallelController(cfg: ParallelControllerConfig): Promise<void> {
  const {
    projectName,
    projectSpec,
    repoUrl,
    branch,
    model,
    workingDir,
    parallelWorkers,
    stopFilePath,
    cleanTaskBranches,
    prompts,
    continuous,
    specAuditMaxAreas,
    specAuditParallelism,
  } = cfg;
  const baseBranch = process.env.REPOSITORY_BASE_BRANCH ?? branch;

  const harness = new LongRunningHarness({
    workingDir,
    projectSpec,
    projectName,
    model,
    repositoryUrl: repoUrl,
    branch,
    baseBranch,
    gitToken: process.env.GITHUB_TOKEN,
    useProjectSettings: true,
    stopFilePath,
    enableReviewAgent: false,
    prompts,
    continuous,
    specAuditMaxAreas,
    specAuditParallelism,
    mcpServers: {
      playwright: {
        command: "npx",
        args: [
          "-y",
          "@playwright/mcp@latest",
          "--browser", "chromium",
          "--headless",
        ],
      },
    },
  });

  await harness.ensureInitialized();

  const client = new ModalClient();
  const app = await client.apps.fromName(`looper-${projectName}`, { createIfMissing: true });

  const volumePool = new Map<number, any>();
  for (let i = 1; i <= parallelWorkers; i++) {
    const volume = await client.volumes.fromName(`${projectName}-worker-${i}`, { createIfMissing: true });
    volumePool.set(i, volume);
  }

  const availableSlots = Array.from({ length: parallelWorkers }, (_, i) => i + 1);
  const activeWorkers = new Map<string, WorkerState>();

  if (cleanTaskBranches) {
    await cleanupRemoteTaskBranches(workingDir, repoUrl, process.env.GITHUB_TOKEN);
  }

  const terminateActiveWorkers = async (reason: string) => {
    if (activeWorkers.size === 0) return;
    const workers = Array.from(activeWorkers.values());
    logWarn("Harness", `Terminating ${workers.length} worker sandbox(es) (${reason})...`);
    await Promise.allSettled(workers.map(async (worker) => {
      try {
        await worker.sandbox.terminate();
      } catch (err) {
        logWarn("Harness", `Failed to terminate sandbox for ${worker.task.id}`, err);
      }
    }));
    for (const worker of workers) {
      try {
        await deleteRemoteTaskBranch(workingDir, repoUrl, worker.branch, process.env.GITHUB_TOKEN);
      } catch (err) {
        logWarn("Harness", `Failed to delete ${worker.branch} after termination`, err);
      }
    }
    activeWorkers.clear();
  };

  const workerConfig: Config = {
    projectName,
    instruction: projectSpec,
    sessions: 1,
    cpu: 2.0,
    memoryMb: 4096,
    timeoutSecs: 0,
    repoUrl,
    branch,
    model,
    githubToken: process.env.GITHUB_TOKEN,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    parallelWorkers: 1,
    cleanTaskBranches: false,
  };

  while (true) {
    if (await shouldStop(stopFilePath)) {
      logInfo("Harness", "Stop requested; terminating active workers and exiting parallel controller.");
      await terminateActiveWorkers("stop requested");
      break;
    }

    await syncControllerRepo(workingDir, repoUrl, branch, process.env.GITHUB_TOKEN);

    const tasks = await harness.readTaskList();
    const baseSha = (await execGit(["-C", workingDir, "rev-parse", `origin/${branch}`], buildGitEnv())).trim();
    const inProgressRemote = await getActiveRemoteTasks(
      workingDir,
      repoUrl,
      process.env.GITHUB_TOKEN,
      tasks,
      activeWorkers,
      baseSha
    );
    const inProgress = new Set<string>([...inProgressRemote, ...activeWorkers.keys()]);
    const inProgressTasks = tasks.filter((task) => inProgress.has(task.id));

    const readyTasks = getReadyTasks(tasks, { inProgress, inProgressTasks });

    while (availableSlots.length > 0 && readyTasks.length > 0) {
      const task = readyTasks.shift()!;
      const slot = availableSlots.shift()!;
      const branchName = `task/${task.id}`;

      const claimed = await claimTaskBranch(workingDir, repoUrl, branch, task.id, process.env.GITHUB_TOKEN);
      if (!claimed) {
        availableSlots.push(slot);
        continue;
      }

      const volume = volumePool.get(slot)!;
      const worker = await spawnWorkerSandbox({
        client,
        app,
        volume,
        workerConfig,
        projectName,
        repoUrl,
        branch: branchName,
        baseBranch,
        task,
      }, slot);

      activeWorkers.set(task.id, worker);
      logInfo(
        "Harness",
        `Worker started for ${task.id}: ${task.description} (slot ${slot}, ${worker.sandbox.sandboxId})`
      );
    }

    if (activeWorkers.size === 0) {
      const remaining = tasks.filter((task) => task.passes !== true);
      if (remaining.length === 0) {
        if (!continuous) {
          logInfo("Harness", "All tasks are marked as passing. Parallel run complete.");
          break;
        }

        logInfo("Harness", "All tasks passing; running spec audit...");
        const auditResult = await harness.runSpecAudit();
        if (auditResult.addedTasks === 0 && auditResult.reopenedTasks === 0) {
          logInfo("Harness", "Spec audit passed with no new tasks. Parallel run complete.");
          break;
        }
        logInfo(
          "Harness",
          `Spec audit added ${auditResult.addedTasks} task(s) and reopened ${auditResult.reopenedTasks} task(s); continuing.`
        );
        continue;
      }

      if (readyTasks.length === 0) {
        if (inProgressRemote.size > 0) {
          logInfo("Harness", "Waiting for in-progress remote tasks to finish...");
          await delay(10000);
          continue;
        }
        logWarn("Harness", `No ready tasks but ${remaining.length} task(s) remain. Check dependencies.`);
        break;
      }
    }

    if (activeWorkers.size === 0) {
      await delay(5000);
      continue;
    }

    const waitResult = await waitForWorkerOrStop(activeWorkers, stopFilePath);
    if (waitResult.type === "stop") {
      logInfo("Harness", "Stop requested; terminating active workers and exiting parallel controller.");
      await terminateActiveWorkers("stop requested");
      break;
    }

    const result = waitResult.result;
    const finished = activeWorkers.get(result.taskId);
    if (finished) {
      activeWorkers.delete(result.taskId);
      availableSlots.push(finished.slot);
    }

    if (result.exitCode === 0) {
      const merged = await isTaskBranchMerged(workingDir, repoUrl, branch, result.branch, process.env.GITHUB_TOKEN);
      if (!merged) {
        logWarn(
          "Harness",
          `Worker for ${result.taskId} reported success but ${result.branch} is not merged into ${branch}; leaving branch for inspection.`
        );
        continue;
      }
      await syncControllerRepo(workingDir, repoUrl, branch, process.env.GITHUB_TOKEN);
      const marked = await isTaskMarkedPassing(workingDir, result.taskId);
      if (!marked) {
        logWarn(
          "Harness",
          `Worker for ${result.taskId} merged into ${branch} but did not mark the task as passing; leaving branch for inspection.`
        );
        continue;
      }
      await deleteRemoteTaskBranch(workingDir, repoUrl, result.branch, process.env.GITHUB_TOKEN);
    } else {
      logWarn("Harness", `Worker for ${result.taskId} exited with code ${result.exitCode}; deleting branch ${result.branch}.`);
      try {
        await deleteRemoteTaskBranch(workingDir, repoUrl, result.branch, process.env.GITHUB_TOKEN);
      } catch (err) {
        logWarn("Harness", `Failed to delete ${result.branch} after worker failure`, err);
      }
    }
  }
}

interface WorkerEnvParams {
  workerConfig: Config;
  projectName: string;
  repoUrl: string;
  branch: string;
  baseBranch?: string;
  task: TaskSpec;
  slot: number;
}

export function buildWorkerEnv(params: WorkerEnvParams): NodeJS.ProcessEnv {
  const { workerConfig, projectName, repoUrl, branch, baseBranch, task, slot } = params;
  const env = Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)
  );
  const resolvedBaseBranch = baseBranch ?? process.env.REPOSITORY_BASE_BRANCH ?? workerConfig.branch;
  env.__LOOPER_IN_MODAL = "1";
  env.PROJECT_NAME = projectName;
  env.PROJECT_SPEC_FILE = "/harness/spec.txt";
  env.REPOSITORY_URL = repoUrl;
  env.REPOSITORY_BRANCH = branch;
  env.REPOSITORY_BASE_BRANCH = resolvedBaseBranch;
  env.WORKSPACE_DIR = `/workspace/${projectName}`;
  env.MAX_SESSIONS = "1";
  env.MODEL = workerConfig.model;
  env.LOOPER_ROLE = "worker";
  env.LOOPER_TASK_ID = task.id;
  env.LOOPER_TASK_BRANCH = branch;
  env.LOOPER_WORKER_SLOT = String(slot);
  return env;
}

async function spawnWorkerSandbox(
  params: {
    client: ModalClient;
    app: any;
    volume: any;
    workerConfig: Config;
    projectName: string;
    repoUrl: string;
    branch: string;
    baseBranch: string;
    task: TaskSpec;
  },
  slot: number
): Promise<WorkerState> {
  const { client, app, volume, workerConfig, projectName, repoUrl, branch, baseBranch, task } = params;

  const env = buildWorkerEnv({ workerConfig, projectName, repoUrl, branch, baseBranch, task, slot });

  const secretKeys = ["GITHUB_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_CREDENTIALS_JSON", "CODEX_CREDENTIALS_JSON", "MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"];
  const secretEntries = Object.fromEntries(secretKeys.filter(k => env[k]).map(k => [k, env[k]]));
  const secrets = Object.keys(secretEntries).length ? [await client.secrets.fromObject(secretEntries)] : [];

  const sandbox = await client.sandboxes.create(app, buildImage(client), {
    cpu: workerConfig.cpu,
    memoryMiB: workerConfig.memoryMb,
    timeoutMs: 24 * 60 * 60 * 1000,
    volumes: { "/workspace": volume },
    env,
    secrets,
  });

  await uploadCode(sandbox, workerConfig);

  const setupCmd = `sudo mkdir -p /workspace/${projectName} && sudo chown -R looper:looper /workspace/${projectName} && sudo rm -f /workspace/${projectName}/.git/index.lock /workspace/${projectName}/.git/*.lock 2>/dev/null || true`;
  const setupResult = await exec(sandbox, setupCmd, "/harness", { stream: true });
  if (setupResult.exitCode !== 0) {
    await sandbox.terminate().catch(() => {});
    throw new Error(`Worker ${slot} setup failed with exit code ${setupResult.exitCode}`);
  }

  const cmd = `echo "[Looper] Worker ${slot} starting..." && sudo -E -u looper HOME=/home/looper npx tsx run.ts`;
  const promise = exec(sandbox, cmd, "/harness", {
    stream: true,
    mirrorToSandboxLogs: true,
  }).then(async (result) => {
    await sandbox.terminate().catch(() => {});
    return { taskId: task.id, branch, exitCode: result.exitCode };
  }).catch(async () => {
    await sandbox.terminate().catch(() => {});
    return { taskId: task.id, branch, exitCode: 1 };
  });

  return {
    task,
    branch,
    sandbox,
    slot,
    promise,
  };
}

async function waitForAnyWorker(activeWorkers: Map<string, WorkerState>): Promise<WorkerResult> {
  const promises = Array.from(activeWorkers.values()).map((worker) => worker.promise);
  return Promise.race(promises);
}

async function waitForWorkerOrStop(
  activeWorkers: Map<string, WorkerState>,
  stopFilePath: string
): Promise<{ type: "worker"; result: WorkerResult } | { type: "stop" }> {
  const stopState = { cancelled: false };
  const result = await Promise.race([
    waitForAnyWorker(activeWorkers).then((workerResult) => ({ type: "worker" as const, result: workerResult })),
    waitForStopSignal(stopFilePath, stopState).then(() => ({ type: "stop" as const })),
  ]);
  stopState.cancelled = true;
  return result;
}

async function waitForStopSignal(stopFilePath: string, stopState: { cancelled: boolean }): Promise<void> {
  while (!stopState.cancelled) {
    if (await shouldStop(stopFilePath)) {
      return;
    }
    await delay(1000);
  }
}

function buildGitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
  };
}

function getAuthenticatedRepoUrl(repoUrl: string, gitToken?: string): string {
  if (!gitToken) return repoUrl;
  try {
    const url = new URL(repoUrl);
    if (url.protocol === "https:") {
      url.username = "x-access-token";
      url.password = gitToken;
      return url.toString();
    }
  } catch {
    return repoUrl;
  }
  return repoUrl;
}

async function execGit(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const redactedArgs = args.map(a => a.replace(/x-access-token:[^@]+@/g, "x-access-token:***@"));
  logDebug("Git", `git ${redactedArgs.join(" ")}`);
  const { stdout } = await execFileAsync("git", args, { env });
  return stdout.toString();
}


async function withAuthRemote<T>(
  workingDir: string,
  repoUrl: string,
  gitToken: string | undefined,
  fn: (env: NodeJS.ProcessEnv) => Promise<T>
): Promise<T> {
  const env = buildGitEnv();
  const authUrl = getAuthenticatedRepoUrl(repoUrl, gitToken);
  await execGit(["-C", workingDir, "remote", "set-url", "origin", authUrl], env);
  try {
    return await fn(env);
  } finally {
    await execGit(["-C", workingDir, "remote", "set-url", "origin", repoUrl], env);
  }
}

async function syncControllerRepo(
  workingDir: string,
  repoUrl: string,
  branch: string,
  gitToken?: string
): Promise<void> {
  await withAuthRemote(workingDir, repoUrl, gitToken, async (env) => {
    await execGit(["-C", workingDir, "fetch", "origin", branch], env);
    await execGit(["-C", workingDir, "checkout", branch], env);
    await execGit(["-C", workingDir, "reset", "--hard", `origin/${branch}`], env);
    await execGit(["-C", workingDir, "clean", "-fd"], env);
  });
}

export async function getRemoteTaskBranchInfo(
  workingDir: string,
  repoUrl: string,
  gitToken?: string
): Promise<Map<string, { sha: string; commitTimeMs: number }>> {
  return withAuthRemote(workingDir, repoUrl, gitToken, async (env) => {
    try {
      await execGit(
        ["-C", workingDir, "fetch", "--prune", "--force", "origin", "+refs/heads/task/*:refs/remotes/origin/task/*"],
        env
      );
    } catch (err) {
      logWarn("Harness", "Failed to refresh task/* branches", err);
      return new Map();
    }

    const output = await execGit(
      [
        "-C",
        workingDir,
        "for-each-ref",
        "--format=%(refname:strip=3) %(objectname) %(committerdate:unix)",
        "refs/remotes/origin/task",
      ],
      env
    );

    const map = new Map<string, { sha: string; commitTimeMs: number }>();
    const lines = output.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const [ref, sha, ts] = line.trim().split(/\s+/);
      if (!ref || !sha || !ts) continue;
      if (!ref.startsWith("task/")) continue;
      const taskId = ref.slice("task/".length);
      const time = parseInt(ts, 10);
      if (!Number.isNaN(time)) {
        map.set(taskId, { sha, commitTimeMs: time * 1000 });
      }
    }
    return map;
  });
}

async function listRemoteTaskBranchNames(
  workingDir: string,
  repoUrl: string,
  gitToken?: string
): Promise<string[]> {
  return withAuthRemote(workingDir, repoUrl, gitToken, async (env) => {
    const output = await execGit(["-C", workingDir, "ls-remote", "--heads", "origin", "task/*"], env);
    const branches: string[] = [];
    const lines = output.trim().split("\n").filter(Boolean);
    for (const line of lines) {
      const [, ref] = line.split(/\s+/);
      if (ref?.startsWith("refs/heads/task/")) {
        branches.push(ref.replace("refs/heads/", ""));
      }
    }
    return branches;
  });
}

async function cleanupRemoteTaskBranches(
  workingDir: string,
  repoUrl: string,
  gitToken?: string
): Promise<void> {
  const branches = await listRemoteTaskBranchNames(workingDir, repoUrl, gitToken);
  if (branches.length === 0) {
    logInfo("Harness", "No remote task branches to clean.");
    return;
  }

  logInfo("Harness", `Cleaning ${branches.length} remote task branch(es)...`);
  for (const branch of branches) {
    await deleteRemoteTaskBranch(workingDir, repoUrl, branch, gitToken);
  }
}

async function getActiveRemoteTasks(
  workingDir: string,
  repoUrl: string,
  gitToken: string | undefined,
  tasks: TaskSpec[],
  activeWorkers: Map<string, WorkerState>,
  baseSha: string
): Promise<Set<string>> {
  const taskMap = new Map(tasks.map((task) => [task.id, task]));
  const remoteBranches = await getRemoteTaskBranchInfo(workingDir, repoUrl, gitToken);
  const now = Date.now();

  const active = new Set<string>();
  for (const [taskId, info] of remoteBranches) {
    const task = taskMap.get(taskId);
    if (task?.passes === true) {
      await deleteRemoteTaskBranch(workingDir, repoUrl, `task/${taskId}`, gitToken);
      continue;
    }

    if (activeWorkers.has(taskId)) {
      active.add(taskId);
      continue;
    }

    if (info.sha !== baseSha && now - info.commitTimeMs > STALE_BRANCH_MS) {
      logWarn("Harness", `Reclaiming stale task branch for ${taskId}.`);
      await deleteRemoteTaskBranch(workingDir, repoUrl, `task/${taskId}`, gitToken);
      continue;
    }

    active.add(taskId);
  }

  return active;
}

async function claimTaskBranch(
  workingDir: string,
  repoUrl: string,
  baseBranch: string,
  taskId: string,
  gitToken?: string
): Promise<boolean> {
  return withAuthRemote(workingDir, repoUrl, gitToken, async (env) => {
    await execGit(["-C", workingDir, "fetch", "origin", baseBranch], env);
    const baseSha = (await execGit(["-C", workingDir, "rev-parse", `origin/${baseBranch}`], env)).trim();
    const treeSha = (await execGit(["-C", workingDir, "rev-parse", `${baseSha}^{tree}`], env)).trim();
    const claimMessage = `Claim ${taskId} at ${new Date().toISOString()}`;
    const commitEnv = {
      ...env,
      GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME ?? "Looper Agent",
      GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL ?? "agent@looper.local",
      GIT_COMMITTER_NAME: env.GIT_COMMITTER_NAME ?? "Looper Agent",
      GIT_COMMITTER_EMAIL: env.GIT_COMMITTER_EMAIL ?? "agent@looper.local",
    };
    const claimSha = (await execGit(
      ["-C", workingDir, "commit-tree", treeSha, "-p", baseSha, "-m", claimMessage],
      commitEnv
    )).trim();
    const branchRef = `refs/heads/task/${taskId}`;
    const lease = `${branchRef}:0000000000000000000000000000000000000000`;

    try {
      await execGit(["-C", workingDir, "push", "--force-with-lease=" + lease, "origin", `${claimSha}:${branchRef}`], env);
      return true;
    } catch (err) {
      logWarn("Harness", `Failed to claim task branch for ${taskId}`, err);
      return false;
    }
  });
}

async function isTaskBranchMerged(
  workingDir: string,
  repoUrl: string,
  baseBranch: string,
  taskBranch: string,
  gitToken?: string
): Promise<boolean> {
  return withAuthRemote(workingDir, repoUrl, gitToken, async (env) => {
    const baseRef = `refs/remotes/origin/${baseBranch}`;
    const taskRef = `refs/remotes/origin/${taskBranch}`;
    try {
      await execGit(["-C", workingDir, "fetch", "origin", `${baseBranch}:${baseRef}`], env);
    } catch (err) {
      logWarn("Harness", `Failed to fetch ${baseBranch} for merge check`, err);
      return false;
    }
    try {
      await execGit(["-C", workingDir, "fetch", "--force", "origin", `+${taskBranch}:${taskRef}`], env);
    } catch (err) {
      logWarn("Harness", `Failed to fetch ${taskBranch} for merge check`, err);
      return false;
    }
    try {
      await execGit(["-C", workingDir, "merge-base", "--is-ancestor", taskRef, baseRef], env);
      return true;
    } catch {
      return false;
    }
  });
}

async function isTaskMarkedPassing(workingDir: string, taskId: string): Promise<boolean> {
  const taskListPath = path.join(workingDir, "task_list.json");
  try {
    const raw = await fs.readFile(taskListPath, "utf8");
    const data = JSON.parse(raw) as TaskSpec[];
    const entry = data.find((item) => item.id === taskId);
    return entry?.passes === true;
  } catch (err) {
    logWarn("Harness", `Failed to read task_list.json while checking ${taskId}`, err);
    return false;
  }
}

async function mergeTaskBranch(
  workingDir: string,
  repoUrl: string,
  baseBranch: string,
  taskBranch: string,
  gitToken?: string
): Promise<boolean> {
  return withAuthRemote(workingDir, repoUrl, gitToken, async (env) => {
    try {
      await execGit(["-C", workingDir, "fetch", "origin", baseBranch], env);
      await execGit(["-C", workingDir, "fetch", "origin", taskBranch], env);
      await execGit(["-C", workingDir, "checkout", baseBranch], env);
      await execGit(["-C", workingDir, "reset", "--hard", `origin/${baseBranch}`], env);
      await execGit(["-C", workingDir, "checkout", "-B", taskBranch, `origin/${taskBranch}`], env);
      await execGit(["-C", workingDir, "rebase", `origin/${baseBranch}`], env);
      await execGit(["-C", workingDir, "checkout", baseBranch], env);
      await execGit(["-C", workingDir, "merge", "--ff-only", taskBranch], env);
      await execGit(["-C", workingDir, "push", "origin", baseBranch], env);
      return true;
    } catch (err) {
      try {
        await execGit(["-C", workingDir, "rebase", "--abort"], env);
      } catch {
        // ignore
      }
      logWarn("Harness", `Merge failed for ${taskBranch}`, err);
      return false;
    }
  });
}

async function finalizeTaskCompletion(
  workingDir: string,
  repoUrl: string,
  baseBranch: string,
  task: TaskSpec,
  gitToken?: string
): Promise<void> {
  await withAuthRemote(workingDir, repoUrl, gitToken, async (env) => {
    await execGit(["-C", workingDir, "fetch", "origin", baseBranch], env);
    await execGit(["-C", workingDir, "checkout", baseBranch], env);
    await execGit(["-C", workingDir, "reset", "--hard", `origin/${baseBranch}`], env);

    const taskListPath = path.join(workingDir, "task_list.json");
    const raw = await fs.readFile(taskListPath, "utf8");
    const data = JSON.parse(raw) as TaskSpec[];
    const entry = data.find((item) => item.id === task.id);
    if (!entry) {
      throw new Error(`Task ${task.id} not found when marking complete.`);
    }
    entry.passes = true;

    await fs.writeFile(taskListPath, JSON.stringify(data, null, 2) + "\n");

    const progressPath = path.join(workingDir, "agent-progress.txt");
    const logEntry = `[${new Date().toISOString()}] Completed ${task.id}: ${task.description}\n`;
    await fs.appendFile(progressPath, logEntry, "utf8");

    await execGit(["-C", workingDir, "add", "task_list.json", "agent-progress.txt"], env);
    await execGit(["-C", workingDir, "commit", "-m", `Complete ${task.id}: ${task.description}`], env);
    await execGit(["-C", workingDir, "push", "origin", baseBranch], env);
  });
}

async function deleteRemoteTaskBranch(
  workingDir: string,
  repoUrl: string,
  taskBranch: string,
  gitToken?: string
): Promise<void> {
  await withAuthRemote(workingDir, repoUrl, gitToken, async (env) => {
    try {
      await execGit(["-C", workingDir, "push", "origin", "--delete", taskBranch], env);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("remote ref does not exist") || msg.includes("unable to delete")) {
        logWarn("Harness", `Remote branch ${taskBranch} already deleted; skipping.`);
        return;
      }
      throw err;
    }
  });
}

async function shouldStop(stopFilePath: string): Promise<boolean> {
  try {
    await fs.access(stopFilePath);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────────────────────

async function parseArgs(): Promise<Config> {
  const args = process.argv.slice(2);
  const config: Config = {
    projectName: "",
    instruction: "",
    sessions: 0, // 0 = unlimited sessions until tasks complete or stop file
    cpu: 2.0,
    memoryMb: 4096, // 4GB
    timeoutSecs: 0, // 0 = no timeout
    repoUrl: "",
    branch: "main",
    model: "opus",
    githubToken: process.env.GITHUB_TOKEN,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    parallelWorkers: 1,
    continuous: false,
  };

  let instructionFile = "";
  let promptsFile = "";
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--instruction": config.instruction = args[++i]; break;
      case "--instruction-file": instructionFile = args[++i]; break;
      case "--prompts-file": promptsFile = args[++i]; break;
      case "--sessions": config.sessions = parseInt(args[++i], 10); break;
      case "--cpu": config.cpu = parseFloat(args[++i]); break;
      case "--memory": config.memoryMb = parseInt(args[++i], 10); break;
      case "--timeout": config.timeoutSecs = parseInt(args[++i], 10); break;
      case "--repo-url": config.repoUrl = args[++i]; break;
      case "--branch": config.branch = args[++i]; break;
      case "--model": config.model = args[++i]; break;
      case "--claude-oauth-file": config.claudeOAuthFile = args[++i]; break;
      case "--terminate": config.terminateExisting = true; break;
      case "--review-agent": {
        const val = args[++i];
        if (val === "claude" || val === "codex") {
          config.reviewAgent = val;
        } else {
          console.error(`Error: --review-agent must be 'claude' or 'codex', got '${val}'`);
          process.exit(1);
        }
        break;
      }
      case "--codex-model": config.codexModel = args[++i]; break;
      case "--parallel": config.parallelWorkers = parseInt(args[++i], 10); break;
      case "--clean-task-branches": config.cleanTaskBranches = true; break;
      case "--no-clean-task-branches": config.cleanTaskBranches = false; break;
      case "--continuous": config.continuous = true; break;
      case "--spec-audit-max-areas": config.specAuditMaxAreas = parseInt(args[++i], 10); break;
      case "--spec-audit-parallelism": config.specAuditParallelism = parseInt(args[++i], 10); break;
      case "-h": case "--help": printUsage(); process.exit(0);
      default:
        if (!arg.startsWith("-") && !config.projectName) {
          config.projectName = arg;
        }
    }
    i++;
  }

  if (instructionFile && !config.instruction) {
    config.instruction = await fs.readFile(instructionFile, "utf8");
  }

  if (promptsFile) {
    try {
      const promptsContent = await fs.readFile(promptsFile, "utf8");
      config.prompts = JSON.parse(promptsContent);
    } catch (err) {
      console.error(`Error: Failed to read prompts file from ${promptsFile}:`, err);
      process.exit(1);
    }
  }

  if (config.claudeOAuthFile) {
    try {
      config.claudeOAuthCredentials = await fs.readFile(config.claudeOAuthFile, "utf8");
      JSON.parse(config.claudeOAuthCredentials);
    } catch (err) {
      console.error(`Error: Failed to read OAuth credentials from ${config.claudeOAuthFile}:`, err);
      process.exit(1);
    }
  } else {
    const defaultPath = "./.claude-code-credentials.json";
    try {
      const content = await fs.readFile(defaultPath, "utf8");
      config.claudeOAuthCredentials = content;
      config.claudeOAuthFile = defaultPath;
      JSON.parse(content);
    } catch {
      // File doesn't exist or invalid, fall back to API key
    }
  }

  if (!config.repoUrl && config.projectName) {
    const owner = process.env.GITHUB_OWNER;
    if (owner) {
      config.repoUrl = `https://github.com/${owner}/${config.projectName}.git`;
    }
  }

  return config;
}

function printUsage() {
  console.log(`
Usage: npx tsx run.ts <project-name> [options]

Options:
  --instruction <text>     Project spec as string
  --instruction-file <f>   Path to spec file
  --prompts-file <f>       Path to JSON file with prompt overrides (for non-code domains)
  --sessions <n>           Working sessions (default: unlimited if 0)
  --cpu <cores>            CPU cores (default: 4.0)
  --memory <mb>            Memory MB (default: 16384)
  --timeout <secs>         Timeout seconds (default: none if 0)
  --parallel <n>           Parallel worker sandboxes (default: 1)
  --clean-task-branches    Delete all remote task/* branches before starting (default: on)
  --no-clean-task-branches Keep remote task/* branches (disable cleanup)
  --continuous             After tasks complete, run a Codex spec audit and continue if new tasks are added
  --spec-audit-max-areas <n> Max audit areas/reviewers (default: 10)
  --spec-audit-parallelism <n> Max parallel Codex reviewers (default: 3)
  --repo-url <url>         GitHub repo URL
  --branch <branch>        Git branch (default: main)
  --model <model>          Claude model: opus, sonnet, etc. (default: opus)
  --claude-oauth-file <f>  Path to Claude Code OAuth credentials JSON (default: ./.claude-code-credentials.json)
  --review-agent <agent>   Code review agent: claude, codex (default: codex)
  --codex-model <model>    Codex CLI model for review (default: codex's default)

Environment:
  GITHUB_OWNER             Derive repo URL from owner + project name
  GITHUB_TOKEN             Required for private repos
  ANTHROPIC_API_KEY        Required if OAuth credentials not provided
  OPENAI_API_KEY           Required when using --review-agent codex

Example:
  npx tsx run.ts cowsay --instruction "Build a CLI that prints ASCII cow"
  npx tsx run.ts myapp --instruction-file spec.txt --review-agent codex
`);
}

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
