import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  query,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

const execFileAsync = promisify(execFile);

/**
 * Configuration for the long-running project harness.
 */
export interface LongRunningHarnessConfig {
  /**
   * Directory where the project lives. All agent work happens here.
   * Defaults to current working directory.
   */
  workingDir?: string;

  /**
   * Natural-language project spec, e.g. "Build a clone of claude.ai".
   * This is passed to the planning agent.
   */
  projectSpec: string;

  /**
   * Optional human-friendly project name, used only in prompts.
   */
  projectName?: string;

  /**
   * Claude model alias or id, e.g. "opus", "sonnet".
   * If omitted, the SDK default is used.
   */
  model?: string;

  /**
   * Max turns for the planning session.
   */
  maxPlanningTurns?: number;

  /**
   * Max turns for each working session.
   */
  maxWorkingTurns?: number;

  /**
   * If true, load project-level settings/CLAUDE.md via `settingSources: ['project']`.
   * See Agent SDK docs.
   */
  useProjectSettings?: boolean;

  /**
   * Extra Options to pass through to the Agent SDK.
   * These override the harness defaults where they overlap.
   */
  sdkOptionsOverride?: Partial<Options>;

  /**
   * Optional callback for streaming SDK messages (for logging/UI).
   * The harness still performs its default console logging.
   */
  onMessage?: (msg: SDKMessage, phase: HarnessPhase) => void;

  /** Optional MCP server definitions (e.g., Puppeteer) passed through to the SDK. */
  mcpServers?: Options["mcpServers"];

  /** GitHub repository URL to treat as the canonical source of truth (required). */
  repositoryUrl: string;

  /** Branch to track on the remote repository (default: main). */
  branch?: string;

  /** Optional path to a stop-after-session sentinel file. If present, exit after finishing the current session. */
  stopFilePath?: string;

  /**
   * Personal access token for GitHub operations. If omitted, falls back to
   * process.env.GITHUB_TOKEN. Used via Authorization header; not logged.
   */
  gitToken?: string;
}

export type HarnessPhase = "planning" | "working";

interface ProjectPaths {
  taskList: string;
  progressLog: string;
  initScript: string;
  gitDir: string;
}

interface TaskSpec {
  id: string;
  category: string;
  description: string;
  steps: string[];
  passes?: boolean;
}

type TaskList = TaskSpec[];

/**
 * LongRunningHarness implements a two-agent harness on top of the Claude Agent SDK:
 *
 *  - Planning agent: first session only. Analyzes the project spec and creates:
 *      * task_list.json — COMPREHENSIVE list of ALL tasks from the spec with `passes` flags
 *      * claude-progress.txt — log of requirements analysis + onboarding notes
 *      * init.sh — placeholder script (working agent will flesh this out)
 *      * CLAUDE.md — project context for future agents
 *      * initial git repo + commit
 *      NOTE: Planning agent does NOT scaffold the project. "project-setup" is the FIRST task.
 *
 *  - Working agent: each subsequent session:
 *      * Gets oriented (pwd, git log, progress log, task list, init.sh)
 *      * Chooses a single failing task (starting with "project-setup" to scaffold)
 *      * Implements it end-to-end
 *      * Verifies it via tests / smoke checks
 *      * Marks the task as passing and commits + logs progress
 *
 * Each call to runWorkingSession() is an independent context window; the state
 * lives entirely in the repo (files + git history), following the pattern
 * described in Anthropic's long-running agents blog.
 */
export class LongRunningHarness {
  private readonly cfg: LongRunningHarnessConfig;
  private readonly paths: ProjectPaths;
  private readonly workingDir: string;
  private readonly branch: string;
  private readonly repositoryUrl: string;
  private readonly gitToken?: string;
  private readonly stopFilePath: string;

  constructor(cfg: LongRunningHarnessConfig) {
    this.cfg = cfg;
    if (!cfg.repositoryUrl) {
      throw new Error("repositoryUrl is required for LongRunningHarness");
    }
    this.workingDir = cfg.workingDir ?? process.cwd();
    this.branch = cfg.branch ?? "main";
    this.repositoryUrl = cfg.repositoryUrl;
    this.gitToken = cfg.gitToken ?? process.env.GITHUB_TOKEN;
    this.stopFilePath =
      cfg.stopFilePath ??
      process.env.LOOPER_STOP_FILE ??
      path.join(this.workingDir, ".looper-stop-after-session");

    this.paths = {
      taskList: path.join(this.workingDir, "task_list.json"),
      progressLog: path.join(this.workingDir, "claude-progress.txt"),
      initScript: path.join(this.workingDir, "init.sh"),
      gitDir: path.join(this.workingDir, ".git"),
    };
  }

  /**
   * Ensure the project has been initialized. If key artifacts are missing,
   * run the planning agent to bootstrap or repair them.
   */
  async ensureInitialized(): Promise<void> {
    await this.syncRepoFromRemote();

    const [hasTaskList, hasProgressLog, hasGit, hasInit] = await Promise.all([
      pathExists(this.paths.taskList),
      pathExists(this.paths.progressLog),
      pathExists(this.paths.gitDir),
      pathExists(this.paths.initScript),
    ]);

    const hasAllArtifacts = hasTaskList && hasProgressLog && hasGit && hasInit;

    if (hasAllArtifacts) {
      const taskListValid = await this.isTaskListValid();

      if (taskListValid) {
        console.log("[Harness] Project already initialized.");
        return;
      }
    }

    console.log("[Harness] Project not fully initialized; running planning agent…");
    await this.runPlanningAgent();
  }

  /**
   * Run a single working session:
   *  - assumes planning already ran (or will run as needed)
   *  - asks Claude to pick one failing task and push it over the line
   */
  async runWorkingSession(): Promise<void> {
    console.log("[Harness] ═══════════════════════════════════════════════════════════");
    console.log("[Harness] Starting working session");
    console.log("[Harness] ═══════════════════════════════════════════════════════════");

    await this.ensureInitialized();

    const remaining = await this.countRemainingTasks();
    if (remaining != null) {
      console.log(`[Harness] Remaining failing tasks: ${remaining}`);
    }

    const nextTask = await this.getNextFailingTask();
    if (nextTask) {
      console.log(`[Harness] Next task to work on: ${nextTask.id} (${nextTask.category})`);
      console.log(`[Harness]   Description: ${nextTask.description}`);
    }
    const isProjectSetup = nextTask?.id === "project-setup";
    if (isProjectSetup) {
      console.log("[Harness] This is project-setup (scaffolding phase)");
    }

    console.log("[Harness] Starting working agent session…");
    const options: Options = {
      ...this.buildBaseOptions("working"),
      maxTurns: this.cfg.maxWorkingTurns,
      // Allow the model to run tools autonomously inside your sandbox.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...this.cfg.sdkOptionsOverride,
    };

    await this.runQuery(this.buildWorkingPrompt(isProjectSetup), options, "working");

    console.log("[Harness] Working session complete, checking for commits to push...");
    await this.pushIfNeeded("working");
    console.log("[Harness] ═══════════════════════════════════════════════════════════");
  }

  /**
   * Convenience helper to run multiple working sessions until:
   *  - task_list.json has no failing tasks, or
   *  - we reach maxSessions
   */
  async runUntilDone(maxSessions: number): Promise<void> {
    await this.ensureInitialized();

    // Treat maxSessions <= 0 as "run until all tasks pass or stop file is hit"
    const sessionLimit =
      maxSessions && maxSessions > 0 ? maxSessions : Number.MAX_SAFE_INTEGER;

    for (let i = 0; i < sessionLimit; i++) {
      const remaining = await this.countRemainingTasks();
      if (remaining === 0) {
        console.log("[Harness] All tasks are marked as passing. Nothing left to do.");
        return;
      }

      const sessionLimit = maxSessions > 0 ? `of ${maxSessions}` : "(unlimited)";
      console.log(
        `[Harness] ===== Working session #${i + 1} ${sessionLimit} | ${remaining ?? "?"} tasks remaining =====`
      );
      await this.runWorkingSession();

      if (await this.shouldStopAfterSession()) {
        console.log("[Harness] Stop requested; exiting after completing this session.");
        return;
      }
    }

    if (sessionLimit !== Number.MAX_SAFE_INTEGER) {
      console.log("[Harness] Reached maxSessions limit.");
    } else {
      console.log("[Harness] Stopping unlimited run loop.");
    }
  }

  /**
   * INTERNAL: Run the planning agent once.
   */
  private async runPlanningAgent(): Promise<void> {
    const options: Options = {
      ...this.buildBaseOptions("planning"),
      maxTurns: this.cfg.maxPlanningTurns,
      // We want the planning agent to freely create files, run `git init`, etc.,
      // but ideally inside a locked-down workspace.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...this.cfg.sdkOptionsOverride,
    };

    await this.runQuery(this.buildPlanningPrompt(), options, "planning");
    await this.pushIfNeeded("planning");
  }

  /**
   * INTERNAL: Core wrapper around Agent SDK query() with streaming + logging.
   * Throws an error if the SDK returns a non-success result.
   */
  private async runQuery(
    prompt: string,
    options: Options,
    phase: HarnessPhase
  ): Promise<void> {
    const stream = query({ prompt, options });
    let lastResult: SDKMessage | null = null;

    for await (const msg of stream) {
      this.defaultLogMessage(msg, phase);
      this.cfg.onMessage?.(msg, phase);

      if (msg.type === "result") {
        lastResult = msg;
      }
    }

    // Check for SDK errors after the stream completes
    if (lastResult && lastResult.type === "result" && lastResult.subtype !== "success") {
      const errorMsg = lastResult.errors?.join("; ") ?? "Unknown error";
      throw new Error(
        `[${phase}] SDK query failed (${lastResult.subtype}): ${errorMsg}`
      );
    }
  }

  /**
   * Ensure local working directory matches the remote GitHub repository if configured.
   * Clones when missing; otherwise fetches + hard resets to origin/<branch>.
   * Handles empty repos by initializing them locally first.
   */
  private async syncRepoFromRemote(): Promise<void> {
    console.log(`[Harness] Syncing from remote: ${this.repositoryUrl} (branch: ${this.branch})`);
    await this.ensureRemoteRepoExists();
    const repoExists = await pathExists(this.paths.gitDir);
    const env = this.buildGitEnv();
    const branchRef = this.branch;
    const authUrl = this.getAuthenticatedRepoUrl();

    if (!repoExists) {
      console.log(`[Harness] No local repo at ${this.workingDir}, cloning...`);
      await fs.mkdir(this.workingDir, { recursive: true });

      // Try to clone; if it fails due to empty repo, initialize locally
      try {
        await this.execGit(
          ["clone", "--branch", branchRef, "--single-branch", authUrl, this.workingDir],
          env
        );
        // Set the remote to the non-authenticated URL for display purposes
        await this.execGit(["-C", this.workingDir, "remote", "set-url", "origin", this.repositoryUrl], env);
        console.log(`[Harness] ✓ Cloned repository successfully`);
        return;
      } catch (err: any) {
        const msg = err?.message ?? "";
        // Handle empty repo (no branches yet)
        if (msg.includes("Remote branch") && msg.includes("not found")) {
          console.log("[Harness] Remote repo is empty, initializing locally...");
          await execFileAsync("git", ["init"], { cwd: this.workingDir, env });
          await execFileAsync("git", ["remote", "add", "origin", this.repositoryUrl], { cwd: this.workingDir, env });
          await execFileAsync("git", ["checkout", "-b", branchRef], { cwd: this.workingDir, env });
          console.log(`[Harness] ✓ Initialized empty local repo`);
          return;
        }
        throw err;
      }
    }

    console.log(`[Harness] Local repo exists, fetching and resetting to origin/${branchRef}...`);
    // Update remote URL to authenticated version for fetch
    await this.execGit(["-C", this.workingDir, "remote", "set-url", "origin", authUrl], env);
    try {
      await this.execGit(["-C", this.workingDir, "fetch", "origin", branchRef], env);
      await this.execGit(["-C", this.workingDir, "checkout", branchRef], env);
      await this.execGit(["-C", this.workingDir, "reset", "--hard", `origin/${branchRef}`], env);
      await this.execGit(["-C", this.workingDir, "clean", "-fd"], env);
      console.log(`[Harness] ✓ Synced to origin/${branchRef}`);
    } catch (err: any) {
      const msg = err?.message ?? "";
      // Handle case where remote branch doesn't exist yet (empty repo)
      if (msg.includes("couldn't find remote ref")) {
        console.log("[Harness] Remote branch doesn't exist yet, using local state...");
      } else {
        throw err;
      }
    }
    // Reset remote URL to non-authenticated version
    await this.execGit(["-C", this.workingDir, "remote", "set-url", "origin", this.repositoryUrl], env);
  }

  /** Build environment for git commands. */
  private buildGitEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    };
  }

  /** Get the repository URL with embedded token for authentication. */
  private getAuthenticatedRepoUrl(): string {
    if (!this.gitToken) {
      return this.repositoryUrl;
    }

    try {
      const url = new URL(this.repositoryUrl);
      if (url.protocol === "https:") {
        url.username = "x-access-token";
        url.password = this.gitToken;
        return url.toString();
      }
    } catch {
      // Not a valid URL, return as-is
    }
    return this.repositoryUrl;
  }

  private async execGit(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
    const redactedArgs = args.map(a => a.replace(/x-access-token:[^@]+@/g, "x-access-token:***@"));
    console.log(`[Harness] git ${redactedArgs.join(" ")}`);
    try {
      const result = await execFileAsync("git", args, { env });
      const stdout = result.stdout?.toString().trim();
      if (stdout) {
        console.log(`[Harness] git output: ${stdout.substring(0, 200)}${stdout.length > 200 ? "..." : ""}`);
      }
      return stdout ?? "";
    } catch (err: any) {
      const stderr =
        (typeof err?.stderr === "string" && err.stderr) ||
        (err?.stderr?.toString?.() as string | undefined) ||
        err?.message ||
        "unknown error";
      // Redact any tokens from error messages
      const redactedStderr = stderr.replace(/x-access-token:[^@]+@/g, "x-access-token:***@");
      console.error(`[Harness] git error: ${redactedStderr.substring(0, 500)}`);
      throw new Error(`[Harness] Git command failed (${redactedArgs.join(" ")}): ${redactedStderr}`);
    }
  }

  /** Push any unpushed commits to origin/<branch>. */
  private async pushIfNeeded(phase: HarnessPhase): Promise<void> {
    console.log(`[Harness] Checking for unpushed commits (${phase})...`);
    const needsToken = this.requiresGithubToken(this.repositoryUrl);
    if (needsToken && !this.gitToken) {
      throw new Error(
        `[Harness] GITHUB_TOKEN is required to push changes to ${this.repositoryUrl}. Provide a token with repo scope before running ${phase}.`
      );
    }

    const env = this.buildGitEnv();

    // Check if there are any commits at all
    let headSha: string | null = null;
    try {
      const result = await execFileAsync("git", ["-C", this.workingDir, "rev-parse", "HEAD"], { env });
      headSha = result.stdout.trim();
      console.log(`[Harness] Current HEAD: ${headSha}`);
    } catch {
      console.log(`[Harness] No commits yet, nothing to push.`);
      return;
    }

    if (!headSha) return;

    // Check for unpushed commits (comparing local HEAD to origin/<branch>)
    let unpushedCommits: string[] = [];
    try {
      const result = await execFileAsync(
        "git",
        ["-C", this.workingDir, "log", `origin/${this.branch}..HEAD`, "--oneline"],
        { env }
      );
      unpushedCommits = result.stdout.trim().split("\n").filter(Boolean);
      console.log(`[Harness] Unpushed commits: ${unpushedCommits.length}`);
      for (const commit of unpushedCommits) {
        console.log(`[Harness]   - ${commit}`);
      }
    } catch {
      // origin/<branch> doesn't exist yet, so all local commits are unpushed
      console.log(`[Harness] Remote branch origin/${this.branch} not found, all commits are unpushed`);
      unpushedCommits = ["all"];
    }

    if (unpushedCommits.length === 0) {
      console.log(`[Harness] No unpushed commits after ${phase} phase.`);
      return;
    }

    // Pull (rebase) then push to origin
    const authUrl = this.getAuthenticatedRepoUrl();
    console.log(`[Harness] Pushing to origin/${this.branch}...`);
    try {
      // First, try to pull with rebase in case remote has new commits
      try {
        console.log(`[Harness] Attempting pull --rebase first...`);
        await this.execGit(["-C", this.workingDir, "pull", "--rebase", authUrl, this.branch], env);
      } catch (pullErr) {
        // Pull may fail if remote branch doesn't exist yet, that's OK
        console.log(`[Harness] Pull --rebase skipped or failed (may be expected):`, pullErr instanceof Error ? pullErr.message : pullErr);
      }
      // Use -u to set upstream if this is the first push
      console.log(`[Harness] Executing push...`);
      await this.execGit(["-C", this.workingDir, "push", "-u", authUrl, this.branch], env);
      console.log(`[Harness] ✓ Successfully pushed ${unpushedCommits.length} commit(s) to origin/${this.branch} (${phase}).`);
    } catch (err) {
      console.error(`[Harness] ✗ Failed to push to origin/${this.branch}:`, err);
      throw new Error(
        `[Harness] Failed to push to origin/${this.branch}. Ensure GITHUB_TOKEN has repo push permissions.`
      );
    }
  }

  private async ensureGitIdentity(env: NodeJS.ProcessEnv): Promise<void> {
    try {
      await execFileAsync("git", ["-C", this.workingDir, "config", "--get", "user.email"], { env });
    } catch {
      await this.execGit(["-C", this.workingDir, "config", "user.email", "agent@looper.local"], env);
    }
    try {
      await execFileAsync("git", ["-C", this.workingDir, "config", "--get", "user.name"], { env });
    } catch {
      await this.execGit(["-C", this.workingDir, "config", "user.name", "Looper Agent"], env);
    }
  }

  /** Ensure the remote GitHub repository exists; create it if missing (requires token). */
  private async ensureRemoteRepoExists(): Promise<void> {
    const parsed = this.parseRepoUrl(this.repositoryUrl);
    if (!parsed || !this.gitToken) return;

    const headers = {
      Authorization: `Bearer ${this.gitToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "looper-harness",
    };

    const check = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}`, {
      headers,
    });
    if (check.status === 200) return;

    const body = JSON.stringify({ name: parsed.repo, private: true });

    const createOrg = await fetch(`https://api.github.com/orgs/${parsed.owner}/repos`, {
      method: "POST",
      headers,
      body,
    });
    if (createOrg.status === 201) return;

    const createUser = await fetch("https://api.github.com/user/repos", {
      method: "POST",
      headers,
      body,
    });

    if (createUser.status !== 201) {
      const text = await createUser.text();
      throw new Error(
        `Failed to ensure remote repo exists (${createUser.status}): ${text || createUser.statusText}`
      );
    }
  }

  private parseRepoUrl(repoUrl: string): { owner: string; repo: string } | null {
    try {
      const url = new URL(repoUrl);
      const parts = url.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
      if (parts.length >= 2) {
        return { owner: parts[0], repo: parts[1] };
      }
    } catch {
      // ignore
    }
    return null;
  }

  private requiresGithubToken(repoUrl: string): boolean {
    try {
      const parsed = new URL(repoUrl);
      if (parsed.protocol.startsWith("http") && parsed.hostname.includes("github.com")) {
        return true;
      }
    } catch {
      // local path or ssh-style; assume token not required
      return false;
    }
    return false;
  }

  private buildBaseOptions(phase: HarnessPhase): Options {
    const { model, useProjectSettings, mcpServers } = this.cfg;

    const base: Options = {
      cwd: this.workingDir,
      model,
      // Use the full Claude Code preset tools (file ops, Bash, web tools, MCP, etc.).
      tools: { type: "preset", preset: "claude_code" },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: this.buildSystemPromptAppend(phase),
      },
      mcpServers,
      settingSources: useProjectSettings ? ["project"] : [],
      includePartialMessages: false,
      stderr: (data: string) => {
        // Surface SDK stderr in a tagged way for observability.
        process.stderr.write(`[SDK ${phase}] ${data}`);
      },
    };

    return base;
  }

  /** Phase-specific system prompt append. */
  private buildSystemPromptAppend(phase: HarnessPhase): string {
    const envInfo = `
ENVIRONMENT INFO:
- Docker/docker-compose is NOT available (container networking restrictions)
- Pre-installed: git, curl, node, go, python3, build-essential
- Modal SDK (TypeScript): Available via npm package "modal" - you CAN spawn Modal sandboxes
- Modal credentials are available in environment (MODAL_TOKEN_ID, MODAL_TOKEN_SECRET)
- For services like databases, download standalone binaries (e.g., etcd, minio)
- Project-specific dependencies should be installed via init.sh
- Playwright MCP browser automation is available (use --browser chromium --headless)

CRITICAL WARNING - DO NOT KILL ALL NODE PROCESSES:
- NEVER run: pkill -f "npm|node|vite" or killall node
- The harness itself runs on Node.js - killing all node processes kills the harness!
- To free a specific port: lsof -ti:PORT | xargs kill -9
- To kill a specific process: pkill -f "specific-process-name"`;

    if (phase === "planning") {
      return `You are the PLANNING agent for a Looper-managed project.
Your PRIMARY job is to create a COMPREHENSIVE task list that covers EVERYTHING
in the project spec. Do NOT implement any tasks or scaffold the project.
Project setup is the FIRST task in the list for a working agent to implement.
Create coordination artifacts (task_list.json, claude-progress.txt, init.sh,
CLAUDE.md) for future working agents. Work on branch ${this.branch}.
${envInfo}`;
    }

    return `You are a WORKING agent for a Looper-managed project.
Your job is to pick up where previous agents left off, implement one task
at a time, and verify it thoroughly. Work on branch ${this.branch}.
${envInfo}`;
  }

  /**
   * Prompt for the planning agent.
   */
  private buildPlanningPrompt(): string {
    const { projectSpec, projectName } = this.cfg;
    const name = projectName ?? "this project";

    return `
You are the PLANNING agent assigned to a long-running project.

Future agents will continue the work in separate sessions. They will NOT see
this conversation; they only see the repo on disk and git history.

Project description:
---
${projectSpec.trim()}
---

Your PRIMARY job is to create a COMPREHENSIVE task list that covers
EVERYTHING in the project spec. Do NOT implement any tasks yourself.
Setting up the project is the FIRST task in the task list.

In this session you must:

1) Carefully analyze the project spec
   - Read every line of the spec above.
   - Identify ALL tasks, requirements, behaviors, and capabilities.
   - Think about edge cases, error handling, and implied requirements.
   - Consider the user journeys and how they interact with the system.

2) Create task_list.json at the repo root
   - It MUST be a JSON array of task objects.
   - The FIRST task MUST be project setup/scaffolding:
       {
         "id": "project-setup",
         "category": "infrastructure",
         "description": "Set up the project with a sensible stack, dependencies, and basic structure",
         "steps": [
           "Run init.sh successfully",
           "Verify the chosen framework/stack is installed",
           "Confirm the project structure matches best practices for the stack"
         ],
         "passes": false
       }
   - For EVERY other requirement in the spec, create a task object with:
       - "id": short, stable identifier (kebab-case)
       - "category": e.g. "functional", "ui", "api", "infrastructure", "performance", "security"
       - "description": one-sentence behavior description
       - "steps": ordered list of manual test steps a human can follow to verify it works
       - "passes": false (always false initially)
   - Be EXHAUSTIVE. Every task, behavior, and capability in the spec must have
     a corresponding entry. If the spec mentions it, there should be a task for it.
   - Include both happy paths AND error cases where the spec implies them.
   - Order tasks roughly by dependency (setup first, then core tasks, then polish).

3) Create claude-progress.txt at the repo root
   - Start a running log for future agents.
   - Include:
       - Summary of the project requirements from your analysis.
       - Total number of tasks identified.
       - Recommended approach/architecture (high-level suggestions only).
       - Note that the first working agent should start with "project-setup".

4) Create a placeholder init.sh script at the repo root
   - This script will be fleshed out by the working agent during project-setup.
   - For now, just create a minimal script:
       #!/bin/bash
       set -e
       echo "Project not yet set up. Run the project-setup task first."
       exit 1
   - Make it executable (chmod +x init.sh).

5) Create CLAUDE.md at the repo root
   - This file provides persistent context for future working agents.
   - Include:
       - Brief project overview based on the spec.
       - Note that the project is not yet implemented.
       - List the key requirements from the spec.
       - Recommend a stack/approach (the working agent will make final decisions).
   - Keep it concise—this is the first thing agents read.

6) Initialize git
   - If no git repo exists, initialize one and set origin to the remote.
   - Add all files and commit with message: "Initial planning: task list and coordination artifacts"
   - Do NOT run "git push" — the harness pushes automatically after your session.

CRITICAL RULES:
- Do NOT scaffold the project or write any application code.
- Do NOT choose specific dependencies or create package.json/requirements.txt etc.
- Do NOT implement any tasks. Your ONLY job is planning and documentation.
- Focus 90% of your effort on creating a COMPLETE task list.
- All "passes" flags MUST be false.
- If you're unsure whether something is a task, include it. More is better.
- If existing artifacts are present, integrate them but ensure the task list
  covers the ENTIRE spec, not just what was previously identified.
`;
  }

  /**
   * Prompt for working sessions.
   * @param isProjectSetup - If true, includes detailed scaffolding instructions
   */
  private buildWorkingPrompt(isProjectSetup: boolean): string {
    const projectSetupSection = isProjectSetup
      ? `
IMPORTANT: You are working on the "project-setup" task.

This means the project has NOT been scaffolded yet. Your job is to:
  - Read CLAUDE.md and claude-progress.txt for recommended stack/approach.
  - Choose and implement a sensible tech stack for the project requirements.
  - Create the project structure (package.json, dependencies, config files, etc.).
  - Set up a basic working skeleton that future tasks can build upon.
  - Update init.sh to properly install dependencies and run a smoke test.
  - Ensure ./init.sh passes before marking project-setup as complete.
  - Prefer boring, well-known frameworks. Avoid exotic dependencies.
`
      : "";

    const verifyEnvironmentSection = isProjectSetup
      ? ""
      : `
3) Verify the environment
   - Run "./init.sh --quick" (fast mode, ~30 seconds).
   - If it fails, dedicate this session to fixing the environment first.
     * Repair dependencies, scripts, or configuration until init.sh succeeds.
     * Document what you fixed in claude-progress.txt.
     * Do NOT mark any tasks as passing while the environment is broken.
   - Do NOT wait for init.sh to complete before proceeding - just verify it starts successfully.
`;

    return `
You are a working agent on a long-running project.

Multiple agents will work on this repo across many sessions. You do not have
access to their conversations; you only see the repo, scripts, tests, and
git history.
${projectSetupSection}
Key artifacts you should rely on (ALL at repo root, not in subdirectories):
- CLAUDE.md — project context and guidelines (read this first).
- task_list.json — list of end-to-end tasks with a "passes" flag.
- claude-progress.txt — log of previous work and instructions (ALWAYS at repo root).
- init.sh — script to start the environment and run smoke tests.
- git log — history of previous changes.

IMPORTANT: Always write to files at the REPO ROOT, not in subdirectories like backend/ or frontend/.

Your job in this session is to:
  1. Get oriented.
  2. Choose a single failing task.
  3. Implement it end-to-end.
  4. Verify it thoroughly.
  5. Leave the environment in a clean, working state.

Follow this checklist strictly:

1) Get your bearings
   - Run "pwd" to confirm the working directory.
   - Ensure the repo is on branch ${this.branch} and synced to origin/${this.branch}.
   - Read claude-progress.txt.
   - Inspect recent git history (e.g. "git log --oneline -20").
   - Open task_list.json.

2) Choose a task
   - Find the highest-priority task whose "passes" flag is false.
   - Tasks are ordered by dependency—work from top to bottom.
   - Work on ONE task only in this session.
${verifyEnvironmentSection}
${isProjectSetup ? "3" : "4"}) Implement the chosen task
   - Plan the change at a high level before editing.
   - Make the smallest coherent set of edits that implement the task
     end-to-end (frontend, backend, DB, etc. as needed).
   - Keep the code clean, incremental, and well-documented.

${isProjectSetup ? "4" : "5"}) Clean up AI-generated patterns ("deslop")
   - Review your diff against the previous state (git diff HEAD).
   - Remove patterns that are inconsistent with the existing codebase style:
       - Extra comments that a human wouldn't add or that clash with the file's style.
       - Unnecessary defensive checks or try/catch blocks in trusted internal codepaths.
       - Casts to \`any\` added just to silence type errors.
       - Overly verbose variable names or redundant abstractions.
       - Any other style inconsistencies with the surrounding code.
   - The goal is code that looks like a skilled human wrote it, not an AI.

${isProjectSetup ? "5" : "6"}) Test like a real user
   - Exercise the full user flow described by that task's "steps".
   - Use browser automation or HTTP calls if the tools are available, and
     complement them with unit or integration tests where helpful.
   - Fix any bugs you find and re-run tests as needed.

${isProjectSetup ? "6" : "7"}) Update coordination artifacts ONLY when the task truly works
   - In task_list.json:
       - Set "passes": true for the completed task.
       - Do NOT edit "category", "description", or "steps" unless you are fixing an objectively incorrect test (e.g., the product requirements changed).
       - It is unacceptable to delete or weaken tests just to make a task appear passing.
       - Do not remove or rename other tasks.
   - In claude-progress.txt:
       - Append an entry summarizing:
           - Which task you worked on (by id).
           - Files and modules you changed.
           - How you tested the behavior.
           - Any limitations, TODOs, or follow-up work for future agents.

${isProjectSetup ? "7" : "8"}) Commit your work
   - Ensure tests and ./init.sh succeed.
   - Ensure there are no stray debug artifacts or half-done migrations.
   - Create a focused git commit with a descriptive message tied to the task.
   - Do NOT run "git push" — the harness pushes automatically after your session.
   - Leave the working tree clean.

Important constraints:
- Never mark a task as passing without real end-to-end verification.
- If the environment is badly broken, favor restoring a healthy baseline over
  adding new tasks.
- If you finish early, invest remaining time in improving tests, docs,
  or small refactors that make future sessions more effective, but do not
  rush to take on a second major task.

Throughout your response:
- Explain what you are doing and why.
- When you change files, mention them explicitly.
- When you test behavior, describe the exact commands or steps you ran.

Begin by summarizing what you see in the repo and which task you plan to tackle.
`;
  }

  private async isTaskListValid(): Promise<boolean> {
    try {
      await this.readTaskList();
      return true;
    } catch (err) {
      console.warn("[Harness] Invalid task_list.json detected.", err);
      return false;
    }
  }

  private async readTaskList(): Promise<TaskList> {
    const raw = await fs.readFile(this.paths.taskList, "utf8");
    const data = JSON.parse(raw);

    if (!Array.isArray(data)) {
      throw new Error("task_list.json is not an array");
    }

    return data.map((item, idx) => {
      if (!item || typeof item !== "object") {
        throw new Error(`task_list.json entry ${idx} is not an object`);
      }

      const record = item as Record<string, unknown>;

      // Validate required string fields
      if (typeof record.id !== "string" || record.id.trim() === "") {
        throw new Error(`task_list.json entry ${idx} is missing a valid "id" string`);
      }
      if (typeof record.category !== "string" || record.category.trim() === "") {
        throw new Error(`task_list.json entry ${idx} is missing a valid "category" string`);
      }
      if (typeof record.description !== "string" || record.description.trim() === "") {
        throw new Error(`task_list.json entry ${idx} is missing a valid "description" string`);
      }

      // Validate steps array
      if (!Array.isArray(record.steps)) {
        throw new Error(`task_list.json entry ${idx} is missing a valid "steps" array`);
      }
      for (let i = 0; i < record.steps.length; i++) {
        if (typeof record.steps[i] !== "string") {
          throw new Error(`task_list.json entry ${idx} has non-string step at index ${i}`);
        }
      }

      // Validate optional passes flag
      if (record.passes !== undefined && typeof record.passes !== "boolean") {
        throw new Error(`task_list.json entry ${idx} has an invalid "passes" flag (must be boolean)`);
      }

      return {
        id: record.id,
        category: record.category,
        description: record.description,
        steps: record.steps as string[],
        passes: record.passes as boolean | undefined,
      };
    });
  }

  /**
   * Count remaining failing tasks in task_list.json, if present.
   * Returns:
   *  - number (>=0) if the file is parseable
   *  - null if the file is missing or malformed
   */
  private async countRemainingTasks(): Promise<number | null> {
    if (!(await pathExists(this.paths.taskList))) {
      return null;
    }

    try {
      const data = await this.readTaskList();
      let remaining = 0;
      for (const item of data) {
        if (item.passes === false || item.passes === undefined) {
          remaining += 1;
        }
      }
      return remaining;
    } catch (err) {
      console.warn(
        "[Harness] Invalid task_list.json; treating remaining tasks as unknown.",
        err
      );
      return null;
    }
  }

  /**
   * Get the first failing task from task_list.json.
   * Returns null if file is missing/malformed or no failing tasks exist.
   */
  private async getNextFailingTask(): Promise<TaskSpec | null> {
    if (!(await pathExists(this.paths.taskList))) {
      return null;
    }

    try {
      const data = await this.readTaskList();
      for (const item of data) {
        if (item.passes === false || item.passes === undefined) {
          return item;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Default message logger if no onMessage callback is provided.
   * Keeps this generic but surfaces key info.
   */
  private defaultLogMessage(msg: SDKMessage, phase: HarnessPhase): void {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") {
          console.log(
            `[${phase}] Session started (model=${msg.model}, permissionMode=${msg.permissionMode})`
          );
        } else if (msg.subtype === "compact_boundary") {
          console.log(
            `[${phase}] --- context compacted (trigger=${msg.compact_metadata.trigger}, pre_tokens=${msg.compact_metadata.pre_tokens})`
          );
        }
        break;

      case "assistant": {
        // Try to extract text blocks from the Anthropic message payload.
        const content = (msg.message as any).content ?? [];
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") {
            console.log(`[${phase}] assistant: ${block.text}`);
          } else if (block?.type === "tool_use") {
            // Log tool name and a brief summary of input
            const inputSummary = this.summarizeToolInput(block.name, block.input);
            console.log(`[${phase}] tool: ${block.name}${inputSummary ? ` (${inputSummary})` : ""}`);
          }
        }
        break;
      }

      case "result":
        if (msg.subtype === "success") {
          console.log(
            `[${phase}] ✓ result: turns=${msg.num_turns}, duration=${msg.duration_ms}ms, cost=$${msg.total_cost_usd.toFixed(
              4
            )}`
          );
        } else {
          console.warn(
            `[${phase}] ✗ result (${msg.subtype}): turns=${msg.num_turns}, errors=${msg.errors?.join(
              "; "
            )}`
          );
        }
        break;

      case "user":
        // Generally just echoes back the initial prompt; safe to ignore.
        break;

      case "stream_event":
        // Partial messages omitted for brevity.
        break;
    }
  }

  /**
   * Summarize tool input for logging purposes.
   */
  private summarizeToolInput(toolName: string, input: any): string {
    if (!input) return "";
    try {
      switch (toolName) {
        case "Bash":
          return input.command?.substring(0, 60) + (input.command?.length > 60 ? "..." : "");
        case "Read":
        case "Write":
          return input.file_path?.split("/").slice(-2).join("/");
        case "Edit":
          return input.file_path?.split("/").slice(-2).join("/");
        case "Glob":
          return input.pattern;
        case "Grep":
          return input.pattern?.substring(0, 40);
        default:
          return "";
      }
    } catch {
      return "";
    }
  }

  /** Check for a sentinel file requesting shutdown after the current session. */
  private async shouldStopAfterSession(): Promise<boolean> {
    return pathExists(this.stopFilePath);
  }
}

/** Simple helper to check if a path exists. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
