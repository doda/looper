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
   * This is passed to the initializer agent.
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
   * Max turns for the initializer session.
   */
  maxInitializerTurns?: number;

  /**
   * Max turns for each coding session.
   */
  maxCodingTurns?: number;

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

export type HarnessPhase = "initializer" | "coding";

interface ProjectPaths {
  featureList: string;
  progressLog: string;
  initScript: string;
  gitDir: string;
}

interface FeatureSpec {
  id: string;
  category: string;
  description: string;
  steps: string[];
  passes?: boolean;
}

type FeatureList = FeatureSpec[];

/**
 * LongRunningHarness implements a two-agent harness on top of the Claude Agent SDK:
 *
 *  - Initializer agent: first session only. Expands the project spec into:
 *      * feature_list.json — structured end-to-end features with `passes` flags
 *      * claude-progress.txt — log of work + onboarding notes
 *      * init.sh — script to boot the env and run a smoke test
 *      * initial git repo + commit
 *
 *  - Coding agent: each subsequent session:
 *      * Gets oriented (pwd, git log, progress log, feature list, init.sh)
 *      * Chooses a single failing feature
 *      * Implements it end-to-end
 *      * Verifies it via tests / smoke checks
 *      * Marks the feature as passing and commits + logs progress
 *
 * Each call to runCodingSession() is an independent context window; the state
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
      featureList: path.join(this.workingDir, "feature_list.json"),
      progressLog: path.join(this.workingDir, "claude-progress.txt"),
      initScript: path.join(this.workingDir, "init.sh"),
      gitDir: path.join(this.workingDir, ".git"),
    };
  }

  /**
   * Ensure the project has been initialized. If key artifacts are missing,
   * run the initializer agent to bootstrap or repair them.
   */
  async ensureInitialized(): Promise<void> {
    await this.syncRepoFromRemote();

    const [hasFeatureList, hasProgressLog, hasGit, hasInit] = await Promise.all([
      pathExists(this.paths.featureList),
      pathExists(this.paths.progressLog),
      pathExists(this.paths.gitDir),
      pathExists(this.paths.initScript),
    ]);

    const hasAllArtifacts = hasFeatureList && hasProgressLog && hasGit && hasInit;

    if (hasAllArtifacts) {
      const featureListValid = await this.isFeatureListValid();

      if (featureListValid) {
        console.log("[Harness] Project already initialized.");
        return;
      }
    }

    console.log("[Harness] Project not fully initialized; running initializer agent…");
    await this.runInitializerAgent();
  }

  /**
   * Run a single coding session:
   *  - assumes initializer already ran (or will run as needed)
   *  - asks Claude to pick one failing feature and push it over the line
   */
  async runCodingSession(): Promise<void> {
    await this.ensureInitialized();

    const remaining = await this.countRemainingFeatures();
    if (remaining != null) {
      console.log(`[Harness] Remaining failing features: ${remaining}`);
    }

    console.log("[Harness] Starting coding agent session…");
    const options: Options = {
      ...this.buildBaseOptions("coding"),
      maxTurns: this.cfg.maxCodingTurns,
      // Allow the model to run tools autonomously inside your sandbox.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...this.cfg.sdkOptionsOverride,
    };

    await this.runQuery(this.buildCodingPrompt(), options, "coding");
    await this.pushIfNeeded("coding");
  }

  /**
   * Convenience helper to run multiple coding sessions until:
   *  - feature_list.json has no failing features, or
   *  - we reach maxSessions
   */
  async runUntilDone(maxSessions: number): Promise<void> {
    await this.ensureInitialized();

    for (let i = 0; i < maxSessions; i++) {
      const remaining = await this.countRemainingFeatures();
      if (remaining === 0) {
        console.log("[Harness] All features are marked as passing. Nothing left to do.");
        return;
      }

      console.log(
        `[Harness] ===== Coding session ${i + 1}/${maxSessions} (remaining=${remaining ?? "unknown"}) =====`
      );
      await this.runCodingSession();

      if (await this.shouldStopAfterSession()) {
        console.log("[Harness] Stop requested; exiting after completing this session.");
        return;
      }
    }

    console.log("[Harness] Reached maxSessions limit.");
  }

  /**
   * INTERNAL: Run the initializer agent once.
   */
  private async runInitializerAgent(): Promise<void> {
    const options: Options = {
      ...this.buildBaseOptions("initializer"),
      maxTurns: this.cfg.maxInitializerTurns,
      // We want the initializer to freely create files, run `git init`, etc.,
      // but ideally inside a locked-down workspace.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...this.cfg.sdkOptionsOverride,
    };

    await this.runQuery(this.buildInitializerPrompt(), options, "initializer");
    await this.pushIfNeeded("initializer");
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
    await this.ensureRemoteRepoExists();
    const repoExists = await pathExists(this.paths.gitDir);
    const env = this.buildGitEnv();
    const branchRef = this.branch;
    const authUrl = this.getAuthenticatedRepoUrl();

    if (!repoExists) {
      await fs.mkdir(this.workingDir, { recursive: true });

      // Try to clone; if it fails due to empty repo, initialize locally
      try {
        await this.execGit(
          ["clone", "--branch", branchRef, "--single-branch", authUrl, this.workingDir],
          env
        );
        // Set the remote to the non-authenticated URL for display purposes
        await this.execGit(["-C", this.workingDir, "remote", "set-url", "origin", this.repositoryUrl], env);
        return;
      } catch (err: any) {
        const msg = err?.message ?? "";
        // Handle empty repo (no branches yet)
        if (msg.includes("Remote branch") && msg.includes("not found")) {
          console.log("[Harness] Remote repo is empty, initializing locally...");
          await execFileAsync("git", ["init"], { cwd: this.workingDir, env });
          await execFileAsync("git", ["remote", "add", "origin", this.repositoryUrl], { cwd: this.workingDir, env });
          await execFileAsync("git", ["checkout", "-b", branchRef], { cwd: this.workingDir, env });
          return;
        }
        throw err;
      }
    }

    // Update remote URL to authenticated version for fetch
    await this.execGit(["-C", this.workingDir, "remote", "set-url", "origin", authUrl], env);
    try {
      await this.execGit(["-C", this.workingDir, "fetch", "origin", branchRef], env);
      await this.execGit(["-C", this.workingDir, "checkout", branchRef], env);
      await this.execGit(["-C", this.workingDir, "reset", "--hard", `origin/${branchRef}`], env);
      await this.execGit(["-C", this.workingDir, "clean", "-fd"], env);
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

  private async execGit(args: string[], env: NodeJS.ProcessEnv): Promise<void> {
    try {
      await execFileAsync("git", args, { env });
    } catch (err: any) {
      const stderr =
        (typeof err?.stderr === "string" && err.stderr) ||
        (err?.stderr?.toString?.() as string | undefined) ||
        err?.message ||
        "unknown error";
      // Redact any tokens from error messages
      const redactedStderr = stderr.replace(/x-access-token:[^@]+@/g, "x-access-token:***@");
      const redactedArgs = args.map(a => a.replace(/x-access-token:[^@]+@/g, "x-access-token:***@"));
      throw new Error(`[Harness] Git command failed (${redactedArgs.join(" ")}): ${redactedStderr}`);
    }
  }

  /** Push any unpushed commits to origin/<branch>. */
  private async pushIfNeeded(phase: HarnessPhase): Promise<void> {
    const needsToken = this.requiresGithubToken(this.repositoryUrl);
    if (needsToken && !this.gitToken) {
      throw new Error(
        `[Harness] GITHUB_TOKEN is required to push changes to ${this.repositoryUrl}. Provide a token with repo scope before running ${phase}.`
      );
    }

    const env = this.buildGitEnv();

    // Check if there are any commits at all
    let hasCommits = false;
    try {
      await execFileAsync("git", ["-C", this.workingDir, "rev-parse", "HEAD"], { env });
      hasCommits = true;
    } catch {
      console.log(`[Harness] No commits yet, nothing to push.`);
      return;
    }

    if (!hasCommits) return;

    // Check for unpushed commits (comparing local HEAD to origin/<branch>)
    let hasUnpushed = true;
    try {
      const result = await execFileAsync(
        "git",
        ["-C", this.workingDir, "log", `origin/${this.branch}..HEAD`, "--oneline"],
        { env }
      );
      hasUnpushed = result.stdout.trim().length > 0;
    } catch {
      // origin/<branch> doesn't exist yet, so all local commits are unpushed
      hasUnpushed = true;
    }

    if (!hasUnpushed) {
      console.log(`[Harness] No unpushed commits after ${phase} phase.`);
      return;
    }

    // Pull (rebase) then push to origin
    const authUrl = this.getAuthenticatedRepoUrl();
    try {
      // First, try to pull with rebase in case remote has new commits
      try {
        await this.execGit(["-C", this.workingDir, "pull", "--rebase", authUrl, this.branch], env);
      } catch {
        // Pull may fail if remote branch doesn't exist yet, that's OK
      }
      // Use -u to set upstream if this is the first push
      await this.execGit(["-C", this.workingDir, "push", "-u", authUrl, this.branch], env);
      console.log(`[Harness] Pushed commits to origin/${this.branch} (${phase}).`);
    } catch (err) {
      console.error(`[Harness] Failed to push to origin/${this.branch}:`, err);
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
- For services like databases, download standalone binaries (e.g., etcd, minio)
- Project-specific dependencies should be installed via init.sh`;

    if (phase === "initializer") {
      return `You are the INITIALIZER agent for a Looper-managed project.
Your job is to choose a reasonable stack, scaffold the project, and create
the coordination artifacts (feature_list.json, claude-progress.txt, init.sh,
CLAUDE.md) for future coding agents. Work on branch ${this.branch}.
${envInfo}`;
    }

    return `You are a CODING agent for a Looper-managed project.
Your job is to pick up where previous agents left off, implement one feature
at a time, and verify it thoroughly. Work on branch ${this.branch}.
${envInfo}`;
  }

  /**
   * Prompt for the initializer agent.
   */
  private buildInitializerPrompt(): string {
    const { projectSpec, projectName } = this.cfg;
    const name = projectName ?? "this project";

    return `
You are the first engineer assigned to a long-running software project.

Future agents will continue the work in separate sessions. They will NOT see
this conversation; they only see the repo on disk and git history.

Project description:
---
${projectSpec.trim()}
---

In this session you must:

1) Scaffold the project
   - Choose a sensible stack and layout for ${name}.
   - Create the minimal code and configuration needed to run the app locally.
   - Prefer boring, well-known frameworks and tooling.
   - Work directly in a git repo cloned from the remote; keep branch ${this.branch}.

2) Create feature_list.json at the repo root
   - It should be a JSON array of feature objects.
   - For each feature, include:
       - "id": short, stable identifier
       - "category": e.g. "functional", "usability", "performance"
       - "description": one-sentence behavior description
       - "steps": ordered list of manual test steps a human can follow
       - "passes": boolean, initially false for every feature
   - Cover all important end-to-end behaviors implied by the project spec,
     not just trivial ones.
   - IMPORTANT: Before finalizing feature_list.json, run at least one test
     command yourself to verify it actually works. Do not assume Node.js
     can execute TypeScript files directly.

3) Create claude-progress.txt at the repo root
   - Start a running log for future agents.
   - Include:
       - Overview of the architecture and tech stack.
       - Exact commands to run the dev server and tests.
       - A bullet list of what you implemented in this session.
       - Clear suggestions for what the next agent should work on.

4) Create an init.sh script at the repo root
   - This script prepares and validates the environment.
   - It should:
       - Install dependencies if needed.
       - Start any dev servers required for e2e testing.
       - Run a minimal smoke test of the core flow
         (for example, a health check or simple end-to-end test).
   - Make it idempotent and safe to run repeatedly.
   - Use clear comments and exit with non-zero status on failure.

5) Create CLAUDE.md at the repo root
   - This file provides persistent context for future coding agents.
   - Include:
       - Brief project overview and architecture.
       - Key technical decisions and constraints.
       - Coding standards specific to this project.
       - Common commands (build, test, run).
       - Any gotchas or important notes for future agents.
   - Keep it concise but informative—this is the first thing agents read.

7) Initialize git
   - If no git repo exists, initialize one and set origin to the remote.
   - Add all relevant files and commit.
   - Do NOT run "git push" — the harness pushes automatically after your session.

General rules:
- Do NOT try to fully implement all features in one go. Focus on a solid,
  well-tested foundation.
- Leave the repo in a working state at the end: app runs, smoke tests pass.
- Treat feature_list.json and claude-progress.txt as the source of truth
  for coordination across sessions.
- Do not mark any feature as passing in this session; all "passes" flags
  should remain false for now.
- If some of these artifacts already exist, update or repair them instead
  of discarding useful work. Preserve git history where possible.
`;
  }

  /**
   * Prompt for coding sessions.
   */
  private buildCodingPrompt(): string {
    return `
You are a coding agent working on a long-running software project.

Multiple agents will work on this repo across many sessions. You do not have
access to their conversations; you only see the repo, scripts, tests, and
git history.

Key artifacts you should rely on:
- CLAUDE.md — project context and guidelines (read this first).
- feature_list.json — list of end-to-end features with a "passes" flag.
- claude-progress.txt — log of previous work and instructions.
- init.sh — script to start the environment and run smoke tests.
- git log — history of previous changes.

Your job in this session is to:
  1. Get oriented.
  2. Choose a single failing feature.
  3. Implement it end-to-end.
  4. Verify it thoroughly.
  5. Leave the environment in a clean, working state.

Follow this checklist strictly:

1) Get your bearings
   - Run "pwd" to confirm the working directory.
   - Ensure the repo is on branch ${this.branch} and synced to origin/${this.branch}.
   - Read claude-progress.txt.
   - Inspect recent git history (e.g. "git log --oneline -20").
   - Open feature_list.json.

2) Choose a feature
   - Find the highest-priority feature whose "passes" flag is false.
   - If priority is not encoded, choose a reasonable next feature and explain
     your reasoning in claude-progress.txt.
   - Work on ONE feature only in this session, unless a tiny supporting change
     is clearly required.

3) Verify the environment
   - Run "./init.sh".
   - If it fails, dedicate this session to fixing the environment.
     * Repair dependencies, scripts, or configuration until init.sh succeeds.
     * Document what you fixed in claude-progress.txt.
     * Do NOT mark any features as passing while the environment is broken.

4) Implement the chosen feature
   - Plan the change at a high level before editing.
   - Make the smallest coherent set of edits that implement the feature
     end-to-end (frontend, backend, DB, etc. as needed).
   - Keep the code clean, incremental, and well-documented.

5) Clean up AI-generated patterns ("deslop")
   - Review your diff against the previous state (git diff HEAD).
   - Remove patterns that are inconsistent with the existing codebase style:
       - Extra comments that a human wouldn't add or that clash with the file's style.
       - Unnecessary defensive checks or try/catch blocks in trusted internal codepaths.
       - Casts to \`any\` added just to silence type errors.
       - Overly verbose variable names or redundant abstractions.
       - Any other style inconsistencies with the surrounding code.
   - The goal is code that looks like a skilled human wrote it, not an AI.

6) Test like a real user
   - Exercise the full user flow described by that feature's "steps".
   - Use browser automation or HTTP calls if the tools are available, and
     complement them with unit or integration tests where helpful.
   - Fix any bugs you find and re-run tests as needed.

7) Update coordination artifacts ONLY when the feature truly works
   - In feature_list.json:
       - Set "passes": true for the completed feature.
       - Do NOT edit "category", "description", or "steps" unless you are fixing an objectively incorrect test (e.g., the product requirements changed).
       - It is unacceptable to delete or weaken tests just to make a feature appear passing.
       - Do not remove or rename other features.
   - In claude-progress.txt:
       - Append an entry summarizing:
           - Which feature you worked on (by id).
           - Files and modules you changed.
           - How you tested the behavior.
           - Any limitations, TODOs, or follow-up work for future agents.

8) Commit your work
   - Ensure tests and ./init.sh succeed.
   - Ensure there are no stray debug artifacts or half-done migrations.
   - Create a focused git commit with a descriptive message tied to the feature.
   - Do NOT run "git push" — the harness pushes automatically after your session.
   - Leave the working tree clean.

Important constraints:
- Never mark a feature as passing without real end-to-end verification.
- If the environment is badly broken, favor restoring a healthy baseline over
  adding new features.
- If you finish early, invest remaining time in improving tests, docs,
  or small refactors that make future sessions more effective, but do not
  rush to take on a second major feature.

Throughout your response:
- Explain what you are doing and why.
- When you change files, mention them explicitly.
- When you test behavior, describe the exact commands or steps you ran.

Begin by summarizing what you see in the repo and which feature you plan to tackle.
`;
  }

  private async isFeatureListValid(): Promise<boolean> {
    try {
      await this.readFeatureList();
      return true;
    } catch (err) {
      console.warn("[Harness] Invalid feature_list.json detected.", err);
      return false;
    }
  }

  private async readFeatureList(): Promise<FeatureList> {
    const raw = await fs.readFile(this.paths.featureList, "utf8");
    const data = JSON.parse(raw);

    if (!Array.isArray(data)) {
      throw new Error("feature_list.json is not an array");
    }

    return data.map((item, idx) => {
      if (!item || typeof item !== "object") {
        throw new Error(`feature_list.json entry ${idx} is not an object`);
      }

      const record = item as Record<string, unknown>;

      // Validate required string fields
      if (typeof record.id !== "string" || record.id.trim() === "") {
        throw new Error(`feature_list.json entry ${idx} is missing a valid "id" string`);
      }
      if (typeof record.category !== "string" || record.category.trim() === "") {
        throw new Error(`feature_list.json entry ${idx} is missing a valid "category" string`);
      }
      if (typeof record.description !== "string" || record.description.trim() === "") {
        throw new Error(`feature_list.json entry ${idx} is missing a valid "description" string`);
      }

      // Validate steps array
      if (!Array.isArray(record.steps)) {
        throw new Error(`feature_list.json entry ${idx} is missing a valid "steps" array`);
      }
      for (let i = 0; i < record.steps.length; i++) {
        if (typeof record.steps[i] !== "string") {
          throw new Error(`feature_list.json entry ${idx} has non-string step at index ${i}`);
        }
      }

      // Validate optional passes flag
      if (record.passes !== undefined && typeof record.passes !== "boolean") {
        throw new Error(`feature_list.json entry ${idx} has an invalid "passes" flag (must be boolean)`);
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
   * Count remaining failing features in feature_list.json, if present.
   * Returns:
   *  - number (>=0) if the file is parseable
   *  - null if the file is missing or malformed
   */
  private async countRemainingFeatures(): Promise<number | null> {
    if (!(await pathExists(this.paths.featureList))) {
      return null;
    }

    try {
      const data = await this.readFeatureList();
      let remaining = 0;
      for (const item of data) {
        if (item.passes === false || item.passes === undefined) {
          remaining += 1;
        }
      }
      return remaining;
    } catch (err) {
      console.warn(
        "[Harness] Invalid feature_list.json; treating remaining features as unknown.",
        err
      );
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
            console.log(`[${phase}] tool: ${block.name}`);
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
