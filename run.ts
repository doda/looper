#!/usr/bin/env tsx
/**
 * Looper - Long-running autonomous coding harness
 *
 * Usage:
 *   npx tsx run.ts <project-name> --instruction "Build X"
 *   npx tsx run.ts <project-name> --instruction-file ./spec.txt
 *
 * Options:
 *   --instruction <text>   Project instruction/spec
 *   --instruction-file <f> Path to file containing instruction
 *   --sessions <n>         Number of coding sessions (default: 10)
 *   --cpu <cores>          CPU cores (default: 1.0)
 *   --memory <mb>          Memory in MB (default: 2048)
 *   --timeout <secs>       Timeout in seconds (default: 3600)
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
import { LongRunningHarness } from "./harness.js";

interface Config {
  projectName: string;
  instruction: string;
  sessions: number;
  cpu: number;
  memoryMb: number;
  timeoutSecs: number;
  repoUrl: string;
  branch: string;
  githubToken?: string;
  anthropicApiKey?: string;
  claudeOAuthFile?: string;
  claudeOAuthCredentials?: string;
}

// Detect if running inside Modal sandbox
const IN_MODAL = process.env.__LOOPER_IN_MODAL === "1";
const STOP_FILE_PATH = "/harness/.looper-stop-after-session";

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

  if (!config.anthropicApiKey && !config.claudeOAuthCredentials) {
    console.error("Error: Either ANTHROPIC_API_KEY or --claude-oauth-file is required\n");
    process.exit(1);
  }

  if (config.claudeOAuthCredentials) {
    console.log(`[Looper] Using Claude Code OAuth credentials from ${config.claudeOAuthFile ?? "./.claude-code-credentials.json"}`);
  } else {
    console.log(`[Looper] Using ANTHROPIC_API_KEY for authentication`);
  }

  console.log(`[Looper] Project: ${config.projectName}`);
  console.log(`[Looper] Repo: ${config.repoUrl} (branch ${config.branch})`);
  console.log(`[Looper] Sessions: ${config.sessions}`);

  const client = new ModalClient();
  const appName = `looper-${config.projectName}`;
  const volumeName = `${config.projectName}-volume`;

  const app = await client.apps.fromName(appName, { createIfMissing: true });
  const volume = await client.volumes.fromName(volumeName, { createIfMissing: true });

  // Check for existing running sandboxes to prevent concurrent runs
  const existingSandboxes: string[] = [];
  for await (const sb of client.sandboxes.list({ appId: app.appId })) {
    existingSandboxes.push(sb.sandboxId);
  }
  if (existingSandboxes.length > 0) {
    console.error(`[Looper] ERROR: Found ${existingSandboxes.length} running sandbox(es) for this project:`);
    for (const id of existingSandboxes) {
      console.error(`  - ${id}`);
    }
    console.error(`\nConcurrent runs against the same volume will cause conflicts.`);
    console.error(`Either wait for the existing run to complete, or terminate it with:`);
    console.error(`  modal sandbox terminate ${existingSandboxes[0]}\n`);
    process.exit(1);
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

  const secrets = Object.keys(secretEntries).length > 0
    ? [await client.secrets.fromObject(secretEntries)]
    : [];

  const projectDir = `/workspace/${config.projectName}`;

  console.log("[Looper] Creating sandbox...");
  const sandbox = await client.sandboxes.create(app, image, {
    cpu: config.cpu,
    memoryMiB: config.memoryMb,
    timeoutMs: config.timeoutSecs * 1000,
    volumes: { "/workspace": volume },
    env: {
      __LOOPER_IN_MODAL: "1",
      PROJECT_NAME: config.projectName,
      PROJECT_SPEC_FILE: "/harness/spec.txt",
      REPOSITORY_URL: config.repoUrl,
      REPOSITORY_BRANCH: config.branch,
      WORKSPACE_DIR: projectDir,
      MAX_SESSIONS: String(config.sessions),
      LOOPER_STOP_FILE: STOP_FILE_PATH,
      ...(config.claudeOAuthCredentials ? { CLAUDE_CONFIG_DIR: "/home/looper/.config/claude" } : {}),
    },
    secrets,
  });

  console.log(`[Looper] Sandbox: ${sandbox.sandboxId}`);

  let sigintCount = 0;
  let sandboxTerminated = false;

  const handleSigint = () => {
    sigintCount += 1;

    if (sigintCount === 1) {
      console.log("\n[Looper] Ctrl+C received. Will stop after the current session finishes. Press Ctrl+C again to force terminate.");
      void requestGracefulStop(sandbox);
      return;
    }

    console.log("\n[Looper] Forcing shutdown and terminating sandbox...");
    sandboxTerminated = true;
    void sandbox.terminate().catch((err: unknown) => {
      console.warn("[Looper] Failed to terminate sandbox:", err);
    }).finally(() => {
      process.exit(1);
    });
  };

  process.on("SIGINT", handleSigint);

  try {
    await uploadCode(sandbox, config);
    await ensureRepoExists(config);

    const cmd = `sudo mkdir -p ${projectDir} && sudo chown -R looper:looper ${projectDir} && sudo -E -u looper HOME=/home/looper npx tsx run.ts`;

    console.log("─".repeat(60));
    const result = await exec(sandbox, cmd, "/harness", {
      stream: true,
      mirrorToSandboxLogs: true,
    });
    console.log("─".repeat(60));

    process.exitCode = result.exitCode;
  } finally {
    process.off("SIGINT", handleSigint);
    if (config.claudeOAuthCredentials && config.claudeOAuthFile) {
      await syncCredentialsFromSandbox(sandbox, config.claudeOAuthFile);
    }
    if (!sandboxTerminated) {
      await sandbox.terminate();
    }
    console.log("[Looper] Done.");
  }
}

function buildImage(client: ModalClient) {
  // Non-root user required: Claude SDK refuses bypassPermissions as root
  return client.images
    .fromRegistry("node:22-slim")
    .dockerfileCommands([
      // Core tools (general purpose)
      "RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y git curl ca-certificates sudo procps build-essential python3 python3-pip && rm -rf /var/lib/apt/lists/*",
      // Go (commonly needed)
      "RUN curl -fsSL https://go.dev/dl/go1.23.4.linux-amd64.tar.gz | tar -C /usr/local -xz",
      "ENV PATH=$PATH:/usr/local/go/bin",
      // User setup
      "RUN useradd -m -s /bin/bash looper && echo 'looper ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers",
      "RUN mkdir -p /harness /workspace && chown -R looper:looper /harness /workspace",
      "USER looper",
      "ENV PATH=$PATH:/usr/local/go/bin:/home/looper/go/bin",
      "RUN git config --global user.email 'agent@looper.local' && git config --global user.name 'Looper Agent' && git config --global --add safe.directory '*'",
      "WORKDIR /harness",
    ]);
}

async function uploadCode(sandbox: Sandbox, config: Config) {
  console.log("[Looper] Uploading code...");

  for (const file of ["harness.ts", "run.ts", "package.json", "tsconfig.json"]) {
    const content = await fs.readFile(path.join(process.cwd(), file), "utf8");
    const b64 = Buffer.from(content).toString("base64");
    await exec(sandbox, `echo '${b64}' | base64 -d > '/harness/${file}'`, "/");
  }

  const specB64 = Buffer.from(config.instruction).toString("base64");
  await exec(sandbox, `echo '${specB64}' | base64 -d > '/harness/spec.txt'`, "/");

  console.log("[Looper] Installing dependencies...");
  const result = await exec(sandbox, "npm install", "/harness", {
    stream: true,
    mirrorToSandboxLogs: true,
  });
  if (result.exitCode !== 0) throw new Error("npm install failed");
}

async function requestGracefulStop(sandbox: Sandbox) {
  try {
    await exec(sandbox, `touch '${STOP_FILE_PATH}'`, "/", {});
    console.log("[Looper] Requested graceful shutdown after current session.");
  } catch (err) {
    console.warn("[Looper] Failed to signal graceful shutdown:", err);
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
      console.log("[Looper] No credentials file found in sandbox to sync.");
      return;
    }

    const sandboxCredentials = result.stdout.trim();
    
    let sandboxParsed: { claudeAiOauth?: { accessToken: string; expiresAt: number } };
    try {
      sandboxParsed = JSON.parse(sandboxCredentials);
      if (!sandboxParsed.claudeAiOauth) {
        console.log("[Looper] Sandbox credentials file doesn't contain OAuth data.");
        return;
      }
    } catch (err) {
      console.warn("[Looper] Failed to parse sandbox credentials:", err);
      return;
    }

    let localParsed: { claudeAiOauth?: { accessToken: string; expiresAt: number } } | null = null;
    try {
      const localContent = await fs.readFile(localPath, "utf8");
      localParsed = JSON.parse(localContent);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn("[Looper] Failed to read local credentials:", err);
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
      console.log(`[Looper] Synced refreshed OAuth credentials to ${localPath}`);
      console.log(`[Looper] Token updated: ${localToken !== sandboxToken ? "YES" : "NO"}, Expires at: ${new Date(sandboxExpiresAt).toISOString()}`);
    } else {
      console.log("[Looper] OAuth credentials unchanged, no sync needed.");
    }
  } catch (err) {
    console.warn("[Looper] Failed to sync credentials from sandbox:", err);
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

  const check = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  if (check.status === 200) return;

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

async function runHarness() {
  const projectName = process.env.PROJECT_NAME!;
  const specFile = process.env.PROJECT_SPEC_FILE!;
  const repoUrl = process.env.REPOSITORY_URL!;
  const branch = process.env.REPOSITORY_BRANCH ?? "main";
  const workingDir = process.env.WORKSPACE_DIR!;
  const maxSessions = parseInt(process.env.MAX_SESSIONS ?? "10", 10);
  const stopFilePath = process.env.LOOPER_STOP_FILE ?? path.join(workingDir, ".looper-stop-after-session");

  const projectSpec = await fs.readFile(specFile, "utf8");
  await fs.rm(stopFilePath, { force: true });

  const oauthCredentialsJson = process.env.CLAUDE_CODE_CREDENTIALS_JSON;
  if (oauthCredentialsJson) {
    const configDir = "/home/looper/.config/claude";
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const credentialsPath = path.join(configDir, ".credentials.json");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(credentialsPath, oauthCredentialsJson, "utf8");
    delete process.env.ANTHROPIC_API_KEY;
    console.log(`[Harness] Using Claude Code OAuth credentials from ${credentialsPath}`);
  } else if (process.env.ANTHROPIC_API_KEY) {
    console.log(`[Harness] Using ANTHROPIC_API_KEY for authentication`);
  } else {
    console.warn(`[Harness] Warning: No authentication credentials found (neither OAuth nor ANTHROPIC_API_KEY)`);
  }

  console.log(`[Harness] Project: ${projectName}`);
  console.log(`[Harness] Repo: ${repoUrl} (branch ${branch})`);
  console.log(`[Harness] Sessions: ${maxSessions}`);

  const harness = new LongRunningHarness({
    workingDir,
    projectSpec,
    projectName,
    model: "sonnet",
    repositoryUrl: repoUrl,
    branch,
    gitToken: process.env.GITHUB_TOKEN,
    useProjectSettings: true,
    stopFilePath,
  });

  let sigintCount = 0;
  const handleSigint = async () => {
    sigintCount += 1;
    if (sigintCount === 1) {
      console.log("\n[Harness] Ctrl+C received. Will stop after the current session finishes. Press Ctrl+C again to exit immediately.");
      try {
        await fs.writeFile(stopFilePath, "stop", "utf8");
      } catch (err) {
        console.warn("[Harness] Failed to write stop file:", err);
      }
      return;
    }

    console.log("\n[Harness] Exiting immediately due to repeated Ctrl+C.");
    process.exit(1);
  };

  process.on("SIGINT", handleSigint);

  try {
    await harness.runUntilDone(maxSessions);
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
    sessions: 10,
    cpu: 1.0,
    memoryMb: 2048,
    timeoutSecs: 3600,
    repoUrl: "",
    branch: "main",
    githubToken: process.env.GITHUB_TOKEN,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  };

  let instructionFile = "";
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--instruction": config.instruction = args[++i]; break;
      case "--instruction-file": instructionFile = args[++i]; break;
      case "--sessions": config.sessions = parseInt(args[++i], 10); break;
      case "--cpu": config.cpu = parseFloat(args[++i]); break;
      case "--memory": config.memoryMb = parseInt(args[++i], 10); break;
      case "--timeout": config.timeoutSecs = parseInt(args[++i], 10); break;
      case "--repo-url": config.repoUrl = args[++i]; break;
      case "--branch": config.branch = args[++i]; break;
      case "--claude-oauth-file": config.claudeOAuthFile = args[++i]; break;
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
  --sessions <n>           Coding sessions (default: 10)
  --cpu <cores>            CPU cores (default: 1.0)
  --memory <mb>            Memory MB (default: 2048)
  --timeout <secs>         Timeout seconds (default: 3600)
  --repo-url <url>         GitHub repo URL
  --branch <branch>        Git branch (default: main)
  --claude-oauth-file <f>  Path to Claude Code OAuth credentials JSON (default: ./.claude-code-credentials.json)

Environment:
  GITHUB_OWNER             Derive repo URL from owner + project name
  GITHUB_TOKEN             Required for private repos
  ANTHROPIC_API_KEY        Required if OAuth credentials not provided

Example:
  npx tsx run.ts cowsay --instruction "Build a CLI that prints ASCII cow"
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
