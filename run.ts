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
 *   --idle-timeout <secs>  Idle timeout in seconds (default: 300)
 *   --continuous           After tasks are completed, run a Codex audit and continue if new tasks are added
 *   --spec-audit-max-areas <n> Max audit areas/reviewers (default: 10)
 *   --model <model>        Claude model: opus, sonnet (default: opus)
 *   --primary-agent <a>   Primary agent for planning/working: claude, codex (default: codex)
 *   --claude-oauth-file <f> Path to Claude Code OAuth credentials JSON (default: ./.claude-code-credentials.json)
 *   --enable-review        Enable review agent ping-pong (default: off)
 *
 * Environment:
 *   GITHUB_OWNER           Used to derive repo URL
 *   GITHUB_TOKEN           Required for private repos
 *   ANTHROPIC_API_KEY      Required if OAuth credentials not provided
 *   Codex auth is loaded from ~/.codex/auth.json (run: codex auth login)
 */

import "dotenv/config";
import { ModalClient, type Sandbox, type SandboxFile } from "modal";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { LongRunningHarness, type LongRunningHarnessConfig } from "./harness.js";
import { logDebug, logError, logInfo, logWarn } from "./logger.js";
import { pathExists, sleep } from "./utils.js";

const execFileAsync = promisify(execFile);

interface Config {
  projectName: string;
  instruction: string;
  sessions: number;
  cpu: number;
  memoryMb: number;
  timeoutSecs: number;
  idleTimeoutSecs: number;
  repoUrl: string;
  branch: string;
  model: string;
  primaryAgent?: "claude" | "codex";
  enableReviewAgent?: boolean;
  githubToken?: string;
  anthropicApiKey?: string;
  claudeOAuthFile?: string;
  claudeOAuthCredentials?: string;
  terminateExisting?: boolean;
  reviewAgent?: "claude" | "codex";
  codexModel?: string;
  codexCredentials?: string;
  prompts?: LongRunningHarnessConfig["prompts"];
  continuous?: boolean;
  specAuditMaxAreas?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Timeouts (in milliseconds)
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const DEFAULT_TIMEOUT_MS = 24 * MS_PER_HOUR;
const DEFAULT_IDLE_TIMEOUT_MS = 60 * MS_PER_SECOND;
const FORCE_EXIT_TIMEOUT_MS = 3 * MS_PER_SECOND;
const GITHUB_API_TIMEOUT_MS = 30 * MS_PER_SECOND;
const LOG_POLL_INTERVAL_MS = 2 * MS_PER_SECOND;
const RENEWAL_AFTER_MS = 23 * MS_PER_HOUR;

// File transfer limits
const SMALL_FILE_B64_THRESHOLD = 50_000;
const FILE_CHUNK_SIZE = 40_000;

// Default sandbox resources
const DEFAULT_CPU_CORES = 2.0;
const DEFAULT_MEMORY_MB = 4096;

// Paths and file patterns
const IN_MODAL = process.env.__LOOPER_IN_MODAL === "1";
const STOP_FILE_PATH = "/harness/.looper-stop-after-session";
const HARNESS_STATIC_FILES = new Set(["package.json", "tsconfig.json"]);
const DEFAULT_LOG_DIR = "/workspace/.looper";
const FALLBACK_LOG_DIR = "/tmp/looper";
const LOG_DIR_OVERRIDE = process.env.LOOPER_LOG_DIR;

// Mutable log path state
let activeLogDir = LOG_DIR_OVERRIDE ?? DEFAULT_LOG_DIR;
let activeHarnessLogPath = path.posix.join(activeLogDir, "harness.log");
let activeHarnessExitPath = path.posix.join(activeLogDir, "harness.exit");
let activeHarnessPidPath = path.posix.join(activeLogDir, "harness.pid");
let activeHarnessRunnerPath = path.posix.join(activeLogDir, "run-harness.sh");
let logOpenFailures = 0;

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

/** Validate config and exit if invalid. */
function validateConfig(config: Config): { primaryAgent: "claude" | "codex"; reviewAgent: "claude" | "codex"; enableReviewAgent: boolean } {
  if (!config.projectName || !config.instruction) {
    printUsage();
    process.exit(1);
  }

  if (!config.repoUrl) {
    console.error("Error: Set GITHUB_OWNER or provide --repo-url\n");
    process.exit(1);
  }

  const primaryAgent = config.primaryAgent ?? "codex";
  const reviewAgent = config.reviewAgent ?? "codex";
  const enableReviewAgent = config.enableReviewAgent ?? false;
  
  if (primaryAgent === "codex" && reviewAgent === "claude") {
    console.error("Error: --primary-agent codex cannot be used with --review-agent claude\n");
    process.exit(1);
  }

  return { primaryAgent, reviewAgent, enableReviewAgent };
}

/** Load Claude credentials if needed. */
async function loadClaudeCredentials(config: Config): Promise<void> {
  const oauthFile = config.claudeOAuthFile ?? "./.claude-code-credentials.json";
  if (config.claudeOAuthCredentials || await pathExists(oauthFile)) {
    await syncCredentialsIfAvailable(oauthFile);
    try {
      config.claudeOAuthCredentials = await fs.readFile(oauthFile, "utf8");
      config.claudeOAuthFile = oauthFile;
      JSON.parse(config.claudeOAuthCredentials);
    } catch (err) {
      if (config.claudeOAuthFile) {
        console.error(`Error: Failed to read OAuth credentials from ${config.claudeOAuthFile}:`, err);
        process.exit(1);
      }
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
}

/** Load Codex credentials if needed. */
async function loadCodexCredentials(config: Config, needsClaude: boolean): Promise<void> {
  const codexAuthPath = path.join(process.env.HOME ?? "", ".codex", "auth.json");
  try {
    config.codexCredentials = await fs.readFile(codexAuthPath, "utf8");
    JSON.parse(config.codexCredentials);
    logInfo("Looper", `Using Codex credentials from ${codexAuthPath}`);
  } catch (err) {
    console.error(`Error: Codex requires auth at ${codexAuthPath}`);
    console.error(`Please run: codex auth login`);
    if (needsClaude) {
      console.error(`Or use --primary-agent claude to use Claude as the primary agent`);
    }
    process.exit(1);
  }
}

/** Build secret entries for the sandbox. */
function buildSecretEntries(config: Config): Record<string, string> {
  const entries: Record<string, string> = {};
  if (config.githubToken) entries.GITHUB_TOKEN = config.githubToken;
  if (config.anthropicApiKey && !config.claudeOAuthCredentials) {
    entries.ANTHROPIC_API_KEY = config.anthropicApiKey;
  }
  if (config.claudeOAuthCredentials) {
    entries.CLAUDE_CODE_CREDENTIALS_JSON = config.claudeOAuthCredentials;
  }
  if (config.codexCredentials) {
    entries.CODEX_CREDENTIALS_JSON = config.codexCredentials;
  }
  if (process.env.MODAL_TOKEN_ID) {
    entries.MODAL_TOKEN_ID = process.env.MODAL_TOKEN_ID;
  }
  if (process.env.MODAL_TOKEN_SECRET) {
    entries.MODAL_TOKEN_SECRET = process.env.MODAL_TOKEN_SECRET;
  }
  return entries;
}

/** Handle existing running sandboxes. */
async function handleExistingSandboxes(
  client: ModalClient,
  appId: string,
  terminateExisting: boolean
): Promise<void> {
  const existingSandboxes: Sandbox[] = [];
  for await (const sb of client.sandboxes.list({ appId })) {
    existingSandboxes.push(sb);
  }
  
  if (existingSandboxes.length === 0) return;

  if (terminateExisting) {
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

async function runInModal() {
  const config = await parseArgs();
  const { primaryAgent, reviewAgent, enableReviewAgent } = validateConfig(config);

  // Load credentials based on agent requirements
  const reviewOrAuditEnabled = enableReviewAgent || Boolean(config.continuous);
  const needsClaude = primaryAgent === "claude" || (reviewOrAuditEnabled && reviewAgent === "claude");
  const needsCodex = primaryAgent === "codex" || (reviewOrAuditEnabled && reviewAgent === "codex");

  if (needsClaude) await loadClaudeCredentials(config);
  if (needsCodex) await loadCodexCredentials(config, needsClaude);

  // Log configuration
  logInfo("Looper", `Project: ${config.projectName}`);
  logInfo("Looper", `Repo: ${config.repoUrl} (branch ${config.branch})`);
  logInfo("Looper", `Model: ${config.model}`);
  logInfo("Looper", `Primary agent: ${primaryAgent}`);
  logInfo("Looper", `Review enabled: ${enableReviewAgent ? "yes" : "no"}`);
  logInfo("Looper", `Sessions: ${config.sessions || "unlimited"}`);
  logInfo("Looper", `Modal credentials: ${process.env.MODAL_TOKEN_ID ? "available" : "not set"}`);

  // Set up Modal resources
  const client = new ModalClient();
  const appName = `looper-${config.projectName}`;
  const volumeName = `${config.projectName}-volume`;
  const app = await client.apps.fromName(appName, { createIfMissing: true });
  const volume = await client.volumes.fromName(volumeName, { createIfMissing: true });

  await handleExistingSandboxes(client, app.appId, config.terminateExisting ?? false);

  const image = buildImage(client);
  const secretEntries = buildSecretEntries(config);
  const secrets = Object.keys(secretEntries).length > 0
    ? [await client.secrets.fromObject(secretEntries)]
    : [];

  const projectDir = `/workspace/${config.projectName}`;

  logInfo("Looper", "Creating sandbox...");
  // Modal defaults to ~10 minutes if no timeout is provided. Treat 0 as "long timeout".
  const timeoutMs =
    config.timeoutSecs > 0
      ? config.timeoutSecs * MS_PER_SECOND
      : DEFAULT_TIMEOUT_MS;
  const idleTimeoutMs =
    config.idleTimeoutSecs > 0
      ? config.idleTimeoutSecs * MS_PER_SECOND
      : undefined;

  const sandbox = await client.sandboxes.create(app, image, {
    cpu: config.cpu,
    memoryMiB: config.memoryMb,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(idleTimeoutMs ? { idleTimeoutMs } : {}),
    volumes: { "/workspace": volume },
    env: {
      __LOOPER_IN_MODAL: "1",
      PROJECT_NAME: config.projectName,
      PROJECT_SPEC_FILE: "/harness/spec.txt",
      REPOSITORY_URL: config.repoUrl,
      REPOSITORY_BRANCH: config.branch,
      REPOSITORY_BASE_BRANCH: config.branch,
      WORKSPACE_DIR: projectDir,
      LOOPER_PRIMARY_AGENT: primaryAgent,
      ...(enableReviewAgent ? { LOOPER_ENABLE_REVIEW: "1" } : {}),
      MAX_SESSIONS: String(config.sessions),
      ...(config.continuous ? { LOOPER_CONTINUOUS: "1" } : {}),
      ...(config.specAuditMaxAreas ? { LOOPER_SPEC_AUDIT_MAX_AREAS: String(config.specAuditMaxAreas) } : {}),
      MODEL: config.model,
      LOOPER_STOP_FILE: STOP_FILE_PATH,
      LOOPER_IDLE_TIMEOUT_SECS: String(config.idleTimeoutSecs),
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
      // Use console.log for synchronous output (pino-pretty is async)
      console.log("\n[Looper] Ctrl+C received. Will stop after the current session finishes. Press Ctrl+C again to force terminate.");
      void requestGracefulStop(sandbox);
      return;
    }

    if (sigintCount >= 3) {
      console.log("\n[Looper] Force exit.");
      process.exit(1);
    }

    console.log("\n[Looper] Forcing shutdown and terminating sandbox...");
    sandboxTerminated = true;
    terminateAllSandboxes().then(() => sandbox.terminate()).then(() => {
      process.exit(1);
    }).catch(() => {
      process.exit(1);
    });
    // Fallback: force exit after 3 seconds if terminate hangs
    setTimeout(() => process.exit(1), FORCE_EXIT_TIMEOUT_MS);
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

    const cmd = `sudo -E -u looper HOME=/home/looper stdbuf -oL -eL npx tsx run.ts`;
    console.log("─".repeat(60));
    let exitCode = 1;
    try {
      await startDetachedHarness(sandbox, cmd, "/harness");
      try {
        await startHarnessKeepalive(sandbox);
      } catch (err) {
        logWarn("Looper", "Failed to start keepalive process", err);
      }
      exitCode = await streamHarnessLogs(sandbox);
    } catch (execErr) {
      logError("Looper", "Harness monitoring failed", execErr);
    }
    console.log("─".repeat(60));
    logInfo("Looper", `Harness exited with code ${exitCode}`);

    process.exitCode = exitCode;
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

export function buildImage(client: ModalClient) {
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
      // Rust - installed as looper user
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
  if (b64.length < SMALL_FILE_B64_THRESHOLD) {
    await exec(sandbox, `echo '${b64}' | base64 -d > '${filePath}'`, "/");
    return;
  }

  // For large files, write base64 in chunks then decode
  const chunkSize = FILE_CHUNK_SIZE;
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

export async function exec(
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

export async function startDetachedHarness(sandbox: Sandbox, cmd: string, cwd: string): Promise<void> {
  await ensureLogDir(sandbox);
  const preflight = await exec(
    sandbox,
    `mkdir -p '${activeLogDir}' && : > '${activeHarnessLogPath}' && echo "[Looper] Log stream initialized..." >> '${activeHarnessLogPath}'`,
    "/"
  );
  if (preflight.exitCode !== 0) {
    throw new Error(`Failed to prepare log file (exit code ${preflight.exitCode})`);
  }
  logInfo("Looper", `Log file ready at ${activeHarnessLogPath}`);

  const script = `#!/usr/bin/env bash
set -o pipefail
cd '${cwd}'
(
  echo "[Looper] Harness process starting..."
  ${cmd}
) 2>&1 | tee -a '${activeHarnessLogPath}' /proc/1/fd/1
echo \${PIPESTATUS[0]} > '${activeHarnessExitPath}'
`;

  await writeFileToSandbox(sandbox, activeHarnessRunnerPath, script);
  logDebug("Looper", "Harness runner script uploaded");
  const launchCmd = `chmod +x '${activeHarnessRunnerPath}' ; ` +
    `rm -f '${activeHarnessExitPath}' '${activeHarnessPidPath}' ; ` +
    `nohup '${activeHarnessRunnerPath}' </dev/null >/dev/null 2>&1 & ` +
    `pid=$! ; ` +
    `echo $pid > '${activeHarnessPidPath}' ; ` +
    "exit 0";
  const result = await exec(sandbox, launchCmd, "/");
  if (result.exitCode !== 0) {
    if (result.stdout) {
      logWarn("Looper", `Harness launch stdout: ${result.stdout.trim()}`);
    }
    if (result.stderr) {
      logWarn("Looper", `Harness launch stderr: ${result.stderr.trim()}`);
    }
    throw new Error(`Failed to start harness (exit code ${result.exitCode})`);
  }
  logInfo("Looper", "Harness runner launched");
}

async function startHarnessKeepalive(sandbox: Sandbox): Promise<void> {
  const keepaliveCmd = [
    "bash",
    "-lc",
    `while [ ! -s '${activeHarnessPidPath}' ]; do sleep 0.5; done; ` +
      `pid=$(cat '${activeHarnessPidPath}'); ` +
      `while kill -0 "$pid" 2>/dev/null; do sleep 30; done`,
  ];
  await sandbox.exec(keepaliveCmd);
  logInfo("Looper", "Keepalive process started");
}

function setActiveLogDir(dir: string): void {
  activeLogDir = dir;
  activeHarnessLogPath = path.posix.join(dir, "harness.log");
  activeHarnessExitPath = path.posix.join(dir, "harness.exit");
  activeHarnessPidPath = path.posix.join(dir, "harness.pid");
  activeHarnessRunnerPath = path.posix.join(dir, "run-harness.sh");
}

async function ensureLogDir(sandbox: Sandbox): Promise<void> {
  const attempt = async (dir: string): Promise<boolean> => {
    const testFile = path.posix.join(dir, ".looper-write-test");
    const result = await exec(
      sandbox,
      `mkdir -p '${dir}' && : > '${testFile}' && rm -f '${testFile}'`,
      "/"
    );
    return result.exitCode === 0;
  };

  if (await attempt(activeLogDir)) {
    return;
  }

  if (activeLogDir === DEFAULT_LOG_DIR) {
    const sudoResult = await exec(
      sandbox,
      `sudo mkdir -p '${DEFAULT_LOG_DIR}' && sudo chown -R looper:looper '${DEFAULT_LOG_DIR}'`,
      "/"
    );
    if (sudoResult.exitCode === 0 && await attempt(DEFAULT_LOG_DIR)) {
      return;
    }
  }

  setActiveLogDir(FALLBACK_LOG_DIR);
  if (!await attempt(activeLogDir)) {
    throw new Error(`Failed to initialize log directory (${activeLogDir})`);
  }
  logWarn("Looper", `Log directory not writable, falling back to ${activeLogDir}`);
}

async function tryOpenLogFile(sandbox: Sandbox): Promise<SandboxFile | undefined> {
  try {
    return await sandbox.open(activeHarnessLogPath, "r");
  } catch (err) {
    logOpenFailures += 1;
    if (logOpenFailures === 1 || logOpenFailures % 10 === 0) {
      logWarn("Looper", `Failed to open log file at ${activeHarnessLogPath}`, err);
    }
    return undefined;
  }
}

async function readExitCode(sandbox: Sandbox): Promise<number | undefined> {
  try {
    const exitFile = await sandbox.open(activeHarnessExitPath, "r");
    const data = await exitFile.read();
    await exitFile.close();
    const text = Buffer.from(data).toString("utf8").trim();
    if (!text) return 0;
    const value = Number(text);
    return Number.isFinite(value) ? value : 0;
  } catch {
    return undefined;
  }
}

export async function streamHarnessLogs(sandbox: Sandbox): Promise<number> {
  let exitCode: number | undefined;
  let offset = 0;
  let lastSize = 0;
  logInfo("Looper", `Starting log stream from ${activeHarnessLogPath}`);

  while (exitCode === undefined) {
    try {
      const logFile = await tryOpenLogFile(sandbox);
      if (logFile) {
        const data = await logFile.read();
        await logFile.close();
        const size = data.length;
        if (size < lastSize) {
          offset = 0;
        }
        if (size > offset) {
          process.stdout.write(Buffer.from(data.slice(offset)));
          offset = size;
        }
        lastSize = size;
        logOpenFailures = 0;
      }
      exitCode = await readExitCode(sandbox);
    } catch (err) {
      logWarn("Looper", "Log stream interrupted; retrying...", err);
    }

    if (exitCode === undefined) {
      await sleep(LOG_POLL_INTERVAL_MS);
    }
  }

  return exitCode;
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
  const timeout = setTimeout(() => controller.abort(), GITHUB_API_TIMEOUT_MS);

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
        cpu: DEFAULT_CPU_CORES,
        memoryMiB: DEFAULT_MEMORY_MB,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        idleTimeoutMs: (() => {
          const idleTimeoutSecs = parseInt(process.env.LOOPER_IDLE_TIMEOUT_SECS ?? "", 10);
          if (Number.isFinite(idleTimeoutSecs) && idleTimeoutSecs > 0) {
            return idleTimeoutSecs * MS_PER_SECOND;
          }
          return DEFAULT_IDLE_TIMEOUT_MS;
        })(),
        volumes: { "/workspace": volume },
        env,
        secrets,
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
  const primaryAgent = (process.env.LOOPER_PRIMARY_AGENT as "claude" | "codex" | undefined) ?? "codex";
  const enableReviewAgent = process.env.LOOPER_ENABLE_REVIEW === "1";
  const workingDir = process.env.WORKSPACE_DIR!;
  const maxSessions = parseInt(process.env.MAX_SESSIONS ?? "10", 10);
  const stopFilePath = process.env.LOOPER_STOP_FILE ?? path.join(workingDir, ".looper-stop-after-session");
  const reviewAgent = process.env.REVIEW_AGENT as "claude" | "codex" | undefined;
  const codexModel = process.env.CODEX_MODEL;
  const promptsJson = process.env.LOOPER_PROMPTS_JSON;
  const prompts = promptsJson ? JSON.parse(promptsJson) as LongRunningHarnessConfig["prompts"] : undefined;
  const continuous = process.env.LOOPER_CONTINUOUS === "1";
  const specAuditMaxAreasRaw = parseInt(process.env.LOOPER_SPEC_AUDIT_MAX_AREAS ?? "", 10);
  const specAuditMaxAreas = Number.isFinite(specAuditMaxAreasRaw) ? specAuditMaxAreasRaw : undefined;

  const projectSpec = await fs.readFile(specFile, "utf8");

  const effectiveReviewAgent = reviewAgent ?? "codex";
  if (primaryAgent === "codex" && effectiveReviewAgent === "claude") {
    throw new Error("primaryAgent=codex cannot use reviewAgent=claude");
  }
  const reviewOrAuditEnabled = enableReviewAgent || Boolean(continuous);
  const needsClaude = primaryAgent === "claude" || (reviewOrAuditEnabled && effectiveReviewAgent === "claude");
  const needsCodex = primaryAgent === "codex" || (reviewOrAuditEnabled && effectiveReviewAgent === "codex");

  if (needsClaude) {
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
  }

  if (needsCodex) {
    const codexCredentialsJson = process.env.CODEX_CREDENTIALS_JSON;
    if (codexCredentialsJson) {
      const codexDir = "/home/looper/.codex";
      const codexAuthPath = path.join(codexDir, "auth.json");
      await fs.mkdir(codexDir, { recursive: true });
      await fs.writeFile(codexAuthPath, codexCredentialsJson, { mode: 0o600 });
      logInfo("Harness", `Using Codex credentials from ${codexAuthPath}`);
    } else {
      logWarn("Harness", "Warning: Codex credentials not provided");
    }
  }

  logInfo("Harness", `Project: ${projectName}`);
  logInfo("Harness", `Repo: ${repoUrl} (branch ${branch})`);
  logInfo("Harness", `Model: ${model}`);
  logInfo("Harness", `Primary agent: ${primaryAgent}`);
  logInfo("Harness", `Review enabled: ${enableReviewAgent ? "yes" : "no"}`);
  logInfo("Harness", `Sessions: ${maxSessions}`);
  logInfo("Harness", `Review agent: ${effectiveReviewAgent}${codexModel ? ` (model: ${codexModel})` : ""}`);
  logInfo("Harness", `Continuous: ${continuous ? "yes" : "no"}`);
  if (continuous) {
    logInfo(
      "Harness",
      `Audit: maxAreas=${specAuditMaxAreas ?? 10}`
    );
  }

  await fs.rm(stopFilePath, { force: true });

  // Schedule self-renewal before 24h timeout (also caches harness to volume)
  await scheduleRenewal(stopFilePath);

  const harness = new LongRunningHarness({
    workingDir,
    projectSpec,
    projectName,
    model,
    primaryAgent,
    repositoryUrl: repoUrl,
    branch,
    baseBranch,
    gitToken: process.env.GITHUB_TOKEN,
    useProjectSettings: true,
    stopFilePath,
    // Review agent ping-pong flow
    enableReviewAgent,
    maxReviewIterations: 5,
    maxReviewTurns: 100,
    reviewAgent: effectiveReviewAgent,
    codexModel,
    prompts,
    continuous,
    specAuditMaxAreas,
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
  const handleSigint = () => {
    sigintCount += 1;
    if (sigintCount === 1) {
      // Use console.log for synchronous output (pino-pretty is async)
      console.log("\n[Harness] Ctrl+C received. Will stop after the current session finishes. Press Ctrl+C again to exit immediately.");
      fs.writeFile(stopFilePath, "stop", "utf8").catch((err) => {
        console.error("[Harness] Failed to write stop file:", err);
      });
      return;
    }

    console.log("\n[Harness] Exiting immediately due to repeated Ctrl+C.");
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
// Argument parsing
// ─────────────────────────────────────────────────────────────────────────────

async function parseArgs(): Promise<Config> {
  const args = process.argv.slice(2);
  const config: Config = {
    projectName: "",
    instruction: "",
    sessions: 0, // 0 = unlimited sessions until tasks are completed or stop file
    cpu: DEFAULT_CPU_CORES,
    memoryMb: DEFAULT_MEMORY_MB,
    timeoutSecs: 0, // 0 = no timeout
    idleTimeoutSecs: 300,
    repoUrl: "",
    branch: "main",
    model: "opus",
    primaryAgent: "codex",
    enableReviewAgent: false,
    githubToken: process.env.GITHUB_TOKEN,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
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
      case "--idle-timeout": config.idleTimeoutSecs = parseInt(args[++i], 10); break;
      case "--repo-url": config.repoUrl = args[++i]; break;
      case "--branch": config.branch = args[++i]; break;
      case "--model": config.model = args[++i]; break;
      case "--primary-agent": {
        const val = args[++i];
        if (val === "claude" || val === "codex") {
          config.primaryAgent = val;
        } else {
          console.error(`Error: --primary-agent must be 'claude' or 'codex', got '${val}'`);
          process.exit(1);
        }
        break;
      }
      case "--enable-review":
        config.enableReviewAgent = true;
        break;
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
      case "--continuous": config.continuous = true; break;
      case "--spec-audit-max-areas": config.specAuditMaxAreas = parseInt(args[++i], 10); break;
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
  --idle-timeout <secs>    Idle timeout seconds (default: 300)
  --continuous             After tasks are completed, run a Codex audit and continue if new tasks are added
  --spec-audit-max-areas <n> Max audit areas/reviewers (default: 10)
  --repo-url <url>         GitHub repo URL
  --branch <branch>        Git branch (default: main)
  --model <model>          Claude model: opus, sonnet, etc. (default: opus)
  --primary-agent <agent>  Primary agent: claude, codex (default: codex)
  --claude-oauth-file <f>  Path to Claude Code OAuth credentials JSON (default: ./.claude-code-credentials.json)
  --review-agent <agent>   Code review agent: claude, codex (default: codex)
  --codex-model <model>    Codex CLI model for review (default: codex's default)
  --enable-review          Enable review agent ping-pong (default: off)

Environment:
  GITHUB_OWNER             Derive repo URL from owner + project name
  GITHUB_TOKEN             Required for private repos
  ANTHROPIC_API_KEY        Required if OAuth credentials not provided
  Codex auth               Loaded from ~/.codex/auth.json (run: codex auth login)

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
