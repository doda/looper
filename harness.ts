import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import {
  query,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

const execFileAsync = promisify(execFile);

/** Format timestamp as HH:MM:SS for log output */
function ts(): string {
  return new Date().toTimeString().slice(0, 8);
}

/** Log with timestamp prefix */
function log(prefix: string, message: string): void {
  console.log(`[${ts()}] [${prefix}] ${message}`);
}

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

  /**
   * Enable the review agent ping-pong flow.
   * When enabled, a separate review agent audits the working agent's changes
   * and the working agent fixes issues until the review passes.
   */
  enableReviewAgent?: boolean;

  /**
   * Max review iterations before giving up.
   * Default: 3
   */
  maxReviewIterations?: number;

  /**
   * Max turns for review agent sessions.
   * Default: 30
   */
  maxReviewTurns?: number;

  /**
   * Which agent to use for code review.
   * - "claude": Use Claude
   * - "codex": Use OpenAI Codex CLI (default, requires @openai/codex installed)
   */
  reviewAgent?: "claude" | "codex";

  /**
   * Model to use for Codex CLI review.
   * If not specified, uses Codex CLI default.
   */
  codexModel?: string;

  /**
   * Enable continuous mode: run a spec audit when all tasks are passing.
   * The audit can add or reopen tasks, then the harness continues.
   */
  continuous?: boolean;

  /**
   * Max number of spec audit areas (reviewers) for Codex CLI.
   * The model decides the actual number up to this cap.
   */
  specAuditMaxAreas?: number;

  /**
   * Max parallel Codex reviewers during spec audit.
   */
  specAuditParallelism?: number;

  /**
   * Optional Codex model override for spec audit.
   * Defaults to codexModel when omitted.
   */
  specAuditModel?: string;

  /**
   * Domain-specific prompt overrides. Use this to adapt Looper for non-code domains
   * like philosophical inquiry, research, writing, etc.
   */
  prompts?: {
    /**
     * Custom verification criteria for the working agent.
     * Replaces the default "test like a real user" section.
     */
    verificationCriteria?: string;

    /**
     * Custom review checklist for the review agent.
     * Replaces the default code-audit checklist.
     */
    reviewChecklist?: string;

    /**
     * Custom red flags that auto-fail review.
     * Replaces default patterns like #[ignore], stub, TODO.
     * Set to empty array to disable red flag detection.
     */
    redFlagPatterns?: string[];

    /**
     * Custom task completion criteria.
     * Appended to working agent prompt.
     */
    completionCriteria?: string;
  };
}

export type HarnessPhase = "planning" | "working" | "review" | "fixing" | "audit";

interface ProjectPaths {
  taskList: string;
  progressLog: string;
  initScript: string;
  gitDir: string;
}

export interface TaskSpec {
  id: string;
  category: string;
  description: string;
  steps: string[];
  passes?: boolean;
  depends_on?: string[];
  scope?: string[];
}

type TaskList = TaskSpec[];

interface SpecAuditPlanArea {
  id: string;
  title: string;
  focus: string;
  paths?: string[];
  rationale?: string;
}

interface SpecAuditPlan {
  areas: SpecAuditPlanArea[];
  notes?: string[];
}

interface SpecAuditIssue {
  issue: string;
  evidence?: string;
  severity?: string;
  spec_ref?: string;
}

interface SpecAuditAreaResult {
  area_id: string;
  status: "PASS" | "FAIL";
  summary?: string;
  issues?: SpecAuditIssue[];
  notes?: string[];
}

interface SpecAuditReopen {
  id: string;
  reason?: string;
}

interface SpecAuditSynthesis {
  result: "PASS" | "FAIL";
  new_tasks?: TaskSpec[];
  reopen_tasks?: SpecAuditReopen[];
  summary?: string[];
}

interface SessionResult {
  sessionId: string | null;
  success: boolean;
  errors?: string[];
  errorSubtype?: string;
}

interface ReviewResult {
  sessionId: string | null;
  passed: boolean;
  issues: string[];
  issuesPath?: string | null;
}

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
  private lastReviewIssuesPath: string | null = null;

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
        log("Harness", "Project already initialized.");
        return;
      }
    }

    log("Harness", "Project not fully initialized; running planning agent…");
    await this.runPlanningAgent();
  }

  /**
   * Run a single working session:
   *  - assumes planning already ran (or will run as needed)
   *  - asks Claude to pick one failing task and push it over the line
   *
   * Returns true if session completed successfully, false if it failed.
   */
  async runWorkingSession(): Promise<boolean> {
    log("Harness", "═══════════════════════════════════════════════════════════");
    log("Harness", "Starting working session");
    log("Harness", "═══════════════════════════════════════════════════════════");

    await this.ensureInitialized();

    const remaining = await this.countRemainingTasks();
    if (remaining != null) {
      log("Harness", `Remaining failing tasks: ${remaining}`);
    }

    const nextTask = await this.getNextFailingTask();
    if (nextTask) {
      log("Harness", `Next task to work on: ${nextTask.id} (${nextTask.category})`);
      log("Harness", `  Description: ${nextTask.description}`);
    }
    const isProjectSetup = nextTask?.id === "project-setup";
    if (isProjectSetup) {
      log("Harness", "This is project-setup (scaffolding phase)");
    }

    const options: Options = {
      ...this.buildBaseOptions("working"),
      maxTurns: this.cfg.maxWorkingTurns,
      // Allow the model to run tools autonomously inside your sandbox.
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...this.cfg.sdkOptionsOverride,
    };

    // If review agent is enabled, use the ping-pong flow
    if (this.cfg.enableReviewAgent && nextTask) {
      return this.runWorkingSessionWithReview(nextTask, isProjectSetup, options, false);
    }

    // Original flow without review agent
    log("Harness", "Starting working agent session…");
    try {
      await this.runQuery(this.buildWorkingPrompt(isProjectSetup, nextTask ?? undefined), options, "working");
      log("Harness", "Working session complete, checking for commits to push...");
      await this.pushIfNeeded("working");
      log("Harness", "═══════════════════════════════════════════════════════════");
      return true;
    } catch (err) {
      console.error("[Harness] ═══════════════════════════════════════════════════════════");
      console.error("[Harness] Working session failed with error:");
      console.error("[Harness]", err instanceof Error ? err.message : err);
      console.error("[Harness] ═══════════════════════════════════════════════════════════");

      // Still try to push any commits that were made before the failure
      try {
        await this.pushIfNeeded("working");
      } catch (pushErr) {
        console.warn("[Harness] Failed to push after error:", pushErr);
      }

      return false;
    }
  }

  /**
   * Run a single working session for a specific task.
   * Used by parallel workers that must not update coordination artifacts.
   */
  async runSingleTask(taskId: string, workerMode = false): Promise<boolean> {
    log("Harness", `Starting single-task session for: ${taskId}`);

    await this.ensureInitialized();

    const taskList = await this.readTaskList();
    const task = taskList.find((item) => item.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found in task_list.json`);
    }

    const isProjectSetup = task.id === "project-setup";
    const options: Options = {
      ...this.buildBaseOptions("working"),
      maxTurns: this.cfg.maxWorkingTurns,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...this.cfg.sdkOptionsOverride,
    };

    if (this.cfg.enableReviewAgent) {
      return this.runWorkingSessionWithReview(task, isProjectSetup, options, workerMode);
    }

    const prompt = workerMode
      ? this.buildWorkingPromptForWorker(isProjectSetup, task)
      : this.buildWorkingPrompt(isProjectSetup, task);

    try {
      await this.runQuery(prompt, options, "working");
      log("Harness", "Single-task session complete, checking for commits to push...");
      await this.pushIfNeeded("working");
      log("Harness", "═══════════════════════════════════════════════════════════");
      return true;
    } catch (err) {
      console.error("[Harness] ═══════════════════════════════════════════════════════════");
      console.error("[Harness] Single-task session failed with error:");
      console.error("[Harness]", err instanceof Error ? err.message : err);
      console.error("[Harness] ═══════════════════════════════════════════════════════════");

      try {
        await this.pushIfNeeded("working");
      } catch (pushErr) {
        console.warn("[Harness] Failed to push after error:", pushErr);
      }

      return false;
    }
  }

  /**
   * Run working session with review agent ping-pong.
   *
   * Flow:
   * 1. Working agent implements (maintains context)
   * 2. Review agent audits (fresh context, adversarial)
   * 3. If issues: working agent fixes (resumed context), then review re-audits (resumed)
   * 4. Repeat until review passes or max iterations reached
   * 5. Review agent marks task as complete (not working agent)
   */
  private async runWorkingSessionWithReview(
    task: TaskSpec,
    isProjectSetup: boolean,
    options: Options,
    workerMode = false
  ): Promise<boolean> {
    const maxIterations = this.cfg.maxReviewIterations ?? 3;

    let workingSessionId: string | null = null;
    let reviewSessionId: string | null = null;

    log("Harness", "═══════════════════════════════════════════════════════════");
    log("Harness", "Review agent enabled - using ping-pong flow");
    log("Harness", "═══════════════════════════════════════════════════════════");

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      log("Harness", `─── Iteration ${iteration}/${maxIterations} ───`);

      try {
        // Phase 1: Working agent implements or fixes
        if (workingSessionId === null) {
          // First iteration: fresh implementation
          log("Harness", "Starting working agent (implementation phase)…");
          const workingPrompt = workerMode
            ? this.buildWorkingPromptForWorkerReview(isProjectSetup, task)
            : this.buildWorkingPromptForReview(isProjectSetup, task);
          const result = await this.runQueryWithSessionCapture(workingPrompt, options, "working");
          workingSessionId = result.sessionId;

          if (!result.success) {
            console.error("[Harness] Working agent failed during implementation");
            // DO NOT push - revert to clean state
            await this.syncRepoFromRemote();
            return false;
          }
        } else {
          // Subsequent iterations: resume with fix instructions
          log("Harness", "Resuming working agent (fixing phase)…");
          const lastIssues = this.lastReviewIssues ?? [];
          const fixPrompt = workerMode
            ? this.buildFixPromptForWorker(lastIssues, this.lastReviewIssuesPath)
            : this.buildFixPrompt(lastIssues, this.lastReviewIssuesPath);
          const result = await this.resumeSession(workingSessionId, fixPrompt, options, "fixing");

          if (!result.success) {
            if (this.isPromptTooLong(result)) {
              log("Harness", "Working agent resume failed due to prompt length; starting a fresh fix session...");
            const freshPrompt = workerMode
              ? this.buildFixPromptForWorker(lastIssues, this.lastReviewIssuesPath)
              : this.buildFixPrompt(lastIssues, this.lastReviewIssuesPath);
            const freshResult = await this.runQueryWithSessionCapture(freshPrompt, options, "fixing");
            workingSessionId = freshResult.sessionId;

              if (!freshResult.success) {
                console.error("[Harness] Working agent failed during fixing (fresh session)");
                // DO NOT push - revert to clean state
                await this.syncRepoFromRemote();
                return false;
              }
            } else {
              console.error("[Harness] Working agent failed during fixing");
              // DO NOT push - revert to clean state
              await this.syncRepoFromRemote();
              return false;
            }
          }
        }

        // DO NOT push yet - wait for review approval
        // Changes are committed locally but not pushed until review passes

        // Check if task already passing and committed - skip review
        const taskList = await this.readTaskList();
        const currentTask = taskList.find((t) => t.id === task.id);
        if (currentTask?.passes === true) {
          log("Harness", `Task ${task.id} already marked passing - pushing`);
          await this.pushIfNeeded("working");
          return true;
        }

        // Phase 2: Review agent audits (default: codex)
        const useCodex = this.cfg.reviewAgent !== "claude";
        log("Harness", `Starting review agent (${useCodex ? "codex" : "claude"})…`);
        let reviewResult: ReviewResult;
        if (useCodex) {
          reviewResult = await this.runCodexReview(task, iteration > 1, workerMode);
        } else {
          reviewResult = await this.runReviewAgent(task, options, reviewSessionId, workerMode);
          reviewSessionId = reviewResult.sessionId;
        }

        if (reviewResult.passed) {
          this.lastReviewIssuesPath = null;
          if (!workerMode) {
            // Verify the reviewer actually updated task_list.json
            const taskList = await this.readTaskList();
            const updatedTask = taskList.find((t) => t.id === task.id);
            if (!updatedTask?.passes) {
              console.warn(`[Harness] Review said PASS but task ${task.id} not marked as passing in task_list.json`);
              console.warn("[Harness] Treating as failed review - reviewer must update task_list.json");
              this.lastReviewIssues = ["Reviewer approved but did not update task_list.json"];
              continue; // Go to next iteration
            }
          }

          log("Harness", "═══════════════════════════════════════════════════════════");
          log("Harness", `✓ Review agent APPROVED task: ${task.id}`);
          log("Harness", "═══════════════════════════════════════════════════════════");
          // Only push after review approval (and task marked passing in controller mode)
          await this.pushIfNeeded("review");
          return true;
        }

        // Store issues for next fix iteration
        this.lastReviewIssues = reviewResult.issues;
        this.lastReviewIssuesPath = reviewResult.issuesPath ?? this.lastReviewIssuesPath;
        log("Harness", `Review agent found ${reviewResult.issues.length} issue(s):`);
        for (const issue of reviewResult.issues) {
          log("Harness", `  - ${issue}`);
        }

        if (iteration === maxIterations) {
          console.error("[Harness] ═══════════════════════════════════════════════════════════");
          console.error(`[Harness] ✗ Task ${task.id} failed review after ${maxIterations} iterations`);
          console.error("[Harness] ═══════════════════════════════════════════════════════════");
          // DO NOT push - review failed, don't commit bad code
          // Revert local changes so next session starts clean
          await this.syncRepoFromRemote();
          return false;
        }

        log("Harness", "Sending issues to working agent for fixes...");

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // OAuth token expiration - throw immediately to stop the harness
        if (errMsg.toLowerCase().includes("oauth") || errMsg.includes("token revoked") || errMsg.includes("/login")) {
          throw new Error(`Authentication expired: ${errMsg}`);
        }

        const isPromptTooLong = errMsg.toLowerCase().includes("prompt is too long") ||
          errMsg.toLowerCase().includes("context length") ||
          errMsg.toLowerCase().includes("too many tokens");

        if (isPromptTooLong && workingSessionId !== null && this.lastReviewIssues.length > 0) {
          // Prompt too long during resume - start fresh fix session
          log("Harness", "Session context too long, starting fresh fix session...");
          try {
            const freshPrompt = workerMode
              ? this.buildFixPromptForWorker(this.lastReviewIssues, this.lastReviewIssuesPath)
              : this.buildFixPrompt(this.lastReviewIssues, this.lastReviewIssuesPath);
            const freshResult = await this.runQueryWithSessionCapture(freshPrompt, options, "fixing");
            workingSessionId = freshResult.sessionId;

            if (freshResult.success) {
              // Fresh session worked, continue to review
              continue;
            }
          } catch (freshErr) {
            log("Harness", `Fresh fix session also failed: ${freshErr instanceof Error ? freshErr.message : freshErr}`);
          }
        }

        console.error("[Harness] ═══════════════════════════════════════════════════════════");
        console.error(`[Harness] Error during iteration ${iteration}:`, errMsg);
        console.error("[Harness] ═══════════════════════════════════════════════════════════");

        // DO NOT push on error - revert to clean state
        try {
          await this.syncRepoFromRemote();
        } catch (syncErr) {
          console.warn("[Harness] Failed to sync after error:", syncErr);
        }

        return false;
      }
    }

    return false;
  }

  // Store last review issues for fix prompt
  private lastReviewIssues: string[] = [];

  /**
   * Convenience helper to run multiple working sessions until:
   *  - task_list.json has no failing tasks, or
   *  - we reach maxSessions
   *  - we hit too many consecutive failures
   */
  async runUntilDone(maxSessions: number): Promise<void> {
    await this.ensureInitialized();

    // Treat maxSessions <= 0 as "run until all tasks pass or stop file is hit"
    const sessionLimit =
      maxSessions && maxSessions > 0 ? maxSessions : Number.MAX_SAFE_INTEGER;

    const maxConsecutiveFailures = 3;
    let consecutiveFailures = 0;
    let successfulSessions = 0;

    for (let i = 0; i < sessionLimit; i++) {
      const remaining = await this.countRemainingTasks();
      if (remaining === 0) {
        if (!this.cfg.continuous) {
          log("Harness", "All tasks are marked as passing. Nothing left to do.");
          return;
        }

        log("Harness", "All tasks passing; starting spec audit...");
        const auditResult = await this.runSpecAudit();
        if (auditResult.addedTasks === 0 && auditResult.reopenedTasks === 0) {
          log("Harness", "Spec audit passed with no new tasks.");
          return;
        }
        log(
          "Harness",
          `Spec audit added ${auditResult.addedTasks} task(s) and reopened ${auditResult.reopenedTasks} task(s); continuing.`
        );
        continue;
      }

      const limitStr = maxSessions > 0 ? `of ${maxSessions}` : "(unlimited)";
      console.log(
        `[Harness] ===== Working session #${i + 1} ${limitStr} | ${remaining ?? "?"} tasks remaining =====`
      );

      const success = await this.runWorkingSession();

      if (success) {
        consecutiveFailures = 0;
        successfulSessions++;
      } else {
        consecutiveFailures++;
        console.warn(
          `[Harness] Session failed. Consecutive failures: ${consecutiveFailures}/${maxConsecutiveFailures}`
        );

        if (consecutiveFailures >= maxConsecutiveFailures) {
          console.error(
            `[Harness] Too many consecutive failures (${consecutiveFailures}). Stopping to prevent infinite loop.`
          );
          console.error(
            `[Harness] Completed ${successfulSessions} successful sessions before failure.`
          );
          throw new Error(
            `Harness stopped after ${consecutiveFailures} consecutive session failures`
          );
        }

        // Brief delay before retrying to avoid hammering the API
        log("Harness", "Waiting 10 seconds before retrying...");
        await new Promise((resolve) => setTimeout(resolve, 10000));
      }

      if (await this.shouldStopAfterSession()) {
        log("Harness", "Stop requested; exiting after completing this session.");
        return;
      }
    }

    if (sessionLimit !== Number.MAX_SAFE_INTEGER) {
      log("Harness", "Reached maxSessions limit.");
    } else {
      log("Harness", "Stopping unlimited run loop.");
    }
  }

  /**
   * Run a spec audit when all tasks are passing.
   * Uses the configured review agent where possible, with fallback on failure.
   */
  async runSpecAudit(): Promise<{ addedTasks: number; reopenedTasks: number }> {
    const reviewAgent = this.cfg.reviewAgent ?? "codex";
    if (reviewAgent === "claude") {
      return this.runClaudeSpecAudit();
    }

    if (!(await this.hasCodexCredentials())) {
      log("audit", "Codex credentials not available; falling back to Claude spec audit.");
      return this.runClaudeSpecAudit();
    }

    try {
      return await this.runCodexSpecAudit();
    } catch (err) {
      log(
        "audit",
        `Codex spec audit failed: ${err instanceof Error ? err.message : String(err)}`
      );
      try {
        return await this.runClaudeSpecAudit();
      } catch (fallbackErr) {
        log(
          "audit",
          `Claude spec audit fallback failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`
        );
        return { addedTasks: 0, reopenedTasks: 0 };
      }
    }
  }

  /**
   * Run a Codex-driven spec audit when all tasks are passing.
   * Returns counts of new and reopened tasks.
   */
  private async runCodexSpecAudit(): Promise<{ addedTasks: number; reopenedTasks: number }> {
    const maxAreas = Math.max(1, this.cfg.specAuditMaxAreas ?? 10);
    const parallelism = Math.max(1, this.cfg.specAuditParallelism ?? 3);
    const repoSummary = await this.buildRepoSummary();

    const plan = await this.runCodexSpecAuditPlan(maxAreas, repoSummary);
    const areas = this.sanitizeSpecAuditAreas(plan.areas, maxAreas);

    const areaResults = await this.runSpecAuditAreas(areas, parallelism, repoSummary);
    const taskListRaw = await fs.readFile(this.paths.taskList, "utf8");
    const synthesis = await this.runCodexSpecAuditSynthesis(
      plan,
      areas,
      areaResults,
      taskListRaw,
      repoSummary
    );

    const { addedTasks, reopenedTasks } = await this.applySpecAuditResults(
      synthesis,
      areas.length
    );

    await this.pushIfNeeded("audit");

    return { addedTasks, reopenedTasks };
  }

  private async runClaudeSpecAudit(): Promise<{ addedTasks: number; reopenedTasks: number }> {
    const before = await this.readTaskList();
    const options: Options = {
      ...this.buildBaseOptions("audit"),
      maxTurns: this.cfg.maxReviewTurns ?? 60,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...this.cfg.sdkOptionsOverride,
    };

    await this.runQuery(this.buildSpecAuditClaudePrompt(), options, "audit");

    const after = await this.readTaskList();
    const { addedTasks, reopenedTasks } = this.countTaskChanges(before, after);

    await this.pushIfNeeded("audit");
    return { addedTasks, reopenedTasks };
  }

  private countTaskChanges(
    before: TaskList,
    after: TaskList
  ): { addedTasks: number; reopenedTasks: number } {
    const beforeById = new Map(before.map((task) => [task.id, task]));
    let addedTasks = 0;
    let reopenedTasks = 0;

    for (const task of after) {
      const prev = beforeById.get(task.id);
      if (!prev) {
        addedTasks += 1;
        continue;
      }
      if (prev.passes === true && task.passes === false) {
        reopenedTasks += 1;
      }
    }

    return { addedTasks, reopenedTasks };
  }

  private async hasCodexCredentials(): Promise<boolean> {
    if (process.env.CODEX_CREDENTIALS_JSON) return true;
    const home = process.env.HOME ?? "/home/looper";
    const authPath = path.join(home, ".codex", "auth.json");
    return pathExists(authPath);
  }

  private async runSpecAuditAreas(
    areas: SpecAuditPlanArea[],
    parallelism: number,
    repoSummary: string
  ): Promise<SpecAuditAreaResult[]> {
    if (areas.length === 0) {
      return [];
    }

    const queue = [...areas];
    const results: SpecAuditAreaResult[] = [];
    const workerCount = Math.min(parallelism, areas.length);

    const workers = Array.from({ length: workerCount }, async () => {
      while (queue.length > 0) {
        const area = queue.shift();
        if (!area) return;
        const result = await this.runCodexSpecAuditArea(area, repoSummary);
        results.push(result);
      }
    });

    await Promise.all(workers);
    return results;
  }

  private async buildRepoSummary(): Promise<string> {
    try {
      const result = await execFileAsync("git", ["-C", this.workingDir, "ls-files"]);
      const files = result.stdout
        .toString()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const topLevel = new Set<string>();
      for (const file of files) {
        const top = file.split("/")[0];
        if (top) topLevel.add(top);
      }
      const topList = Array.from(topLevel).slice(0, 25).join(", ");
      return `Repo summary: ${files.length} tracked files. Top-level entries: ${topList || "(none)"}.`;
    } catch {
      return "Repo summary unavailable.";
    }
  }

  private sanitizeSpecAuditAreas(
    areas: SpecAuditPlanArea[] | undefined,
    maxAreas: number
  ): SpecAuditPlanArea[] {
    const safeAreas = Array.isArray(areas) ? areas : [];
    const normalized: SpecAuditPlanArea[] = [];
    const seen = new Set<string>();

    for (const area of safeAreas) {
      if (!area || typeof area !== "object") continue;
      const rawTitle = typeof area.title === "string" ? area.title.trim() : "";
      const rawFocus = typeof area.focus === "string" ? area.focus.trim() : "";
      let id = typeof area.id === "string" ? area.id.trim() : "";
      if (!id) {
        id = rawTitle ? this.normalizeTaskId(rawTitle) : "";
      }
      if (!id) continue;
      if (seen.has(id)) {
        let suffix = 2;
        while (seen.has(`${id}-${suffix}`)) suffix += 1;
        id = `${id}-${suffix}`;
      }
      seen.add(id);
      normalized.push({
        id,
        title: rawTitle || id,
        focus: rawFocus || "General review",
        paths: Array.isArray(area.paths) ? area.paths.filter((p) => typeof p === "string") : [],
        rationale: typeof area.rationale === "string" ? area.rationale.trim() : undefined,
      });
      if (normalized.length >= maxAreas) break;
    }

    if (normalized.length === 0) {
      normalized.push({
        id: "general",
        title: "General",
        focus: "Overall implementation and spec coverage",
        paths: [],
      });
    }

    return normalized;
  }

  private async runCodexSpecAuditPlan(
    maxAreas: number,
    repoSummary: string
  ): Promise<SpecAuditPlan> {
    const nonce = randomUUID();
    const prompt = this.buildSpecAuditPlanPrompt(maxAreas, repoSummary, nonce);
    const output = await this.execCodexPrompt(prompt, "audit-plan", this.cfg.specAuditModel ?? this.cfg.codexModel);
    const json = this.extractCodexJson(output, "CODEX_AUDIT_PLAN", nonce);
    return JSON.parse(json) as SpecAuditPlan;
  }

  private async runCodexSpecAuditArea(
    area: SpecAuditPlanArea,
    repoSummary: string
  ): Promise<SpecAuditAreaResult> {
    const nonce = randomUUID();
    const prompt = this.buildSpecAuditAreaPrompt(area, repoSummary, nonce);
    const output = await this.execCodexPrompt(
      prompt,
      `audit-area:${area.id}`,
      this.cfg.specAuditModel ?? this.cfg.codexModel
    );
    const json = this.extractCodexJson(output, "CODEX_AUDIT_AREA", nonce);
    return JSON.parse(json) as SpecAuditAreaResult;
  }

  private async runCodexSpecAuditSynthesis(
    plan: SpecAuditPlan,
    areas: SpecAuditPlanArea[],
    areaResults: SpecAuditAreaResult[],
    taskListRaw: string,
    repoSummary: string
  ): Promise<SpecAuditSynthesis> {
    const nonce = randomUUID();
    const prompt = this.buildSpecAuditSynthesisPrompt(
      plan,
      areas,
      areaResults,
      taskListRaw,
      repoSummary,
      nonce
    );
    const output = await this.execCodexPrompt(
      prompt,
      "audit-synthesis",
      this.cfg.specAuditModel ?? this.cfg.codexModel
    );
    const json = this.extractCodexJson(output, "CODEX_AUDIT_SYNTHESIS", nonce);
    return JSON.parse(json) as SpecAuditSynthesis;
  }

  private async applySpecAuditResults(
    synthesis: SpecAuditSynthesis,
    areaCount: number
  ): Promise<{ addedTasks: number; reopenedTasks: number }> {
    const taskList = await this.readTaskList();
    const existingIds = new Set(taskList.map((task) => task.id));
    const reopened = new Set<string>();
    let reopenedTasks = 0;
    let addedTasks = 0;

    for (const reopen of synthesis.reopen_tasks ?? []) {
      if (!reopen || typeof reopen.id !== "string") continue;
      const id = reopen.id.trim();
      if (!id || reopened.has(id)) continue;
      const entry = taskList.find((task) => task.id === id);
      if (!entry) continue;
      if (entry.passes !== false) {
        entry.passes = false;
        reopenedTasks += 1;
      }
      reopened.add(id);
    }

    const newTasks = Array.isArray(synthesis.new_tasks) ? synthesis.new_tasks : [];
    for (const rawTask of newTasks) {
      const normalized = this.normalizeNewTask(rawTask);
      if (!normalized) continue;
      let id = normalized.id;
      if (existingIds.has(id)) {
        let suffix = 2;
        while (existingIds.has(`${id}-${suffix}`)) suffix += 1;
        id = `${id}-${suffix}`;
      }
      normalized.id = id;
      normalized.passes = false;
      taskList.push(normalized);
      existingIds.add(id);
      addedTasks += 1;
    }

    const summaryBits = [
      synthesis.result ? synthesis.result.toUpperCase() : "UNKNOWN",
      `${areaCount} area(s)`,
      `${addedTasks} new`,
      `${reopenedTasks} reopened`,
    ];
    const progressEntry = `[${new Date().toISOString()}] Spec audit (codex): ${summaryBits.join(", ")}.\n`;

    await fs.writeFile(this.paths.taskList, JSON.stringify(taskList, null, 2) + "\n");
    await fs.appendFile(this.paths.progressLog, progressEntry, "utf8");

    const env = this.buildGitEnv();
    await this.ensureGitIdentity(env);
    await execFileAsync("git", ["-C", this.workingDir, "add", "task_list.json", "claude-progress.txt"], { env });

    const status = await execFileAsync("git", ["-C", this.workingDir, "status", "--porcelain"], { env });
    if (status.stdout.trim()) {
      const message = `Spec audit: ${addedTasks} new, ${reopenedTasks} reopened`;
      await execFileAsync("git", ["-C", this.workingDir, "commit", "-m", message], { env });
    }

    return { addedTasks, reopenedTasks };
  }

  private normalizeNewTask(raw: TaskSpec | undefined): TaskSpec | null {
    if (!raw || typeof raw !== "object") return null;
    const id = typeof raw.id === "string" ? this.normalizeTaskId(raw.id) : "";
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    const category = typeof raw.category === "string" ? raw.category.trim() : "audit";
    const steps = Array.isArray(raw.steps)
      ? raw.steps.filter((step) => typeof step === "string" && step.trim().length > 0)
      : [];
    if (!id || !description || steps.length === 0) return null;

    const depends_on = Array.isArray(raw.depends_on)
      ? raw.depends_on.filter((dep) => typeof dep === "string" && dep.trim().length > 0)
      : undefined;
    const scope = Array.isArray(raw.scope)
      ? raw.scope.filter((entry) => typeof entry === "string" && entry.trim().length > 0)
      : undefined;

    return {
      id,
      category,
      description,
      steps,
      depends_on,
      scope,
    };
  }

  private normalizeTaskId(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-+/g, "-");
  }

  private extractCodexJson(output: string, marker: string, nonce: string): string {
    const pattern = new RegExp(
      `<<<${marker}:${nonce}>>>\\s*([\\s\\S]*?)\\s*<<<END_${marker}:${nonce}>>>`,
      "g"
    );
    const matches = [...output.matchAll(pattern)];
    if (matches.length === 0) {
      throw new Error(`Failed to parse Codex output for ${marker}`);
    }
    const last = matches[matches.length - 1];
    return (last?.[1] ?? "").trim();
  }

  private async execCodexPrompt(prompt: string, label: string, model?: string): Promise<string> {
    log("audit", `Running Codex CLI (${label})...`);
    const args = ["exec"];
    if (model) {
      args.push("-m", model);
    }
    args.push("--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", prompt);

    return new Promise((resolve, reject) => {
      const proc = spawn("codex", args, {
        cwd: this.workingDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(this.workingDir, ".git"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          log("audit", `Codex CLI exited with code ${code} (${label}).`);
        } else {
          log("audit", `Codex CLI completed (${label}).`);
        }
        resolve(stdout + stderr);
      });

      proc.on("error", (err) => {
        reject(new Error(`Codex CLI spawn failed (${label}): ${err.message}`));
      });
    });
  }

  private buildSpecAuditPlanPrompt(
    maxAreas: number,
    repoSummary: string,
    nonce: string
  ): string {
    return `You are setting up a spec audit for a Looper-managed project.

Project spec:
---
${this.cfg.projectSpec.trim()}
---

${repoSummary}

Your job: decide how many reviewers (1-${maxAreas}) are needed and define
non-overlapping functional areas to audit. Use fewer areas for small codebases.
If you need more context, inspect the repo (git ls-files, rg, ls).

Return ONLY valid JSON between the markers, with this shape:
{
  "areas": [
    {
      "id": "kebab-case-id",
      "title": "Area name",
      "focus": "What to review in this area",
      "paths": ["optional/path", "optional/glob"],
      "rationale": "why this area matters"
    }
  ],
  "notes": ["optional notes"]
}

<<<CODEX_AUDIT_PLAN:${nonce}>>>
<json>
<<<END_CODEX_AUDIT_PLAN:${nonce}>>>`;
  }

  private buildSpecAuditAreaPrompt(
    area: SpecAuditPlanArea,
    repoSummary: string,
    nonce: string
  ): string {
    const paths = (area.paths ?? []).join(", ");
    return `You are a SPEC AUDITOR for a Looper-managed project.

Project spec:
---
${this.cfg.projectSpec.trim()}
---

${repoSummary}

Area ID: ${area.id}
Area title: ${area.title}
Area focus: ${area.focus}
Relevant paths: ${paths || "(none specified)"}

Audit this area against the spec. Look for missing behavior, incorrect behavior,
or untested/untested-critical paths. If you need more context, inspect the repo.
Do NOT modify any files.

Return ONLY valid JSON between the markers:
{
  "area_id": "${area.id}",
  "status": "PASS" | "FAIL",
  "summary": "short summary",
  "issues": [
    {
      "issue": "what is missing or wrong",
      "evidence": "file:line or command output",
      "severity": "high|medium|low",
      "spec_ref": "spec section or quote"
    }
  ],
  "notes": ["optional notes"]
}

<<<CODEX_AUDIT_AREA:${nonce}>>>
<json>
<<<END_CODEX_AUDIT_AREA:${nonce}>>>`;
  }

  private buildSpecAuditSynthesisPrompt(
    plan: SpecAuditPlan,
    areas: SpecAuditPlanArea[],
    areaResults: SpecAuditAreaResult[],
    taskListRaw: string,
    repoSummary: string,
    nonce: string
  ): string {
    return `You are synthesizing a spec audit for a Looper-managed project.

Project spec:
---
${this.cfg.projectSpec.trim()}
---

${repoSummary}

Audit plan:
${JSON.stringify(plan, null, 2)}

Audit areas:
${JSON.stringify(areas, null, 2)}

Area results:
${JSON.stringify(areaResults, null, 2)}

Existing task_list.json:
${taskListRaw}

Your job: turn findings into actionable tasks.
- If gaps are found, output new tasks or reopen existing ones.
- Avoid duplicate tasks; if an existing task should be revisited, list it in reopen_tasks.
- Ensure any new task id is unique within task_list.json; if it already exists, reopen it or pick a new id.
- If everything is covered, return PASS with empty arrays.

Return ONLY valid JSON between the markers:
{
  "result": "PASS" | "FAIL",
  "new_tasks": [
    {
      "id": "kebab-case-id",
      "category": "functional|api|ui|infra|test|security|performance|docs|audit",
      "description": "one sentence",
      "steps": ["manual verification step 1", "step 2"],
      "depends_on": ["optional-task-id"],
      "scope": ["optional/path"]
    }
  ],
  "reopen_tasks": [
    {
      "id": "existing-task-id",
      "reason": "why it must be reopened"
    }
  ],
  "summary": ["brief notes for humans"]
}

<<<CODEX_AUDIT_SYNTHESIS:${nonce}>>>
<json>
<<<END_CODEX_AUDIT_SYNTHESIS:${nonce}>>>`;
  }

  private buildSpecAuditClaudePrompt(): string {
    return `You are running a spec audit for a Looper-managed project.

Project spec:
---
${this.cfg.projectSpec.trim()}
---

Your job:
- Verify the repo matches the spec.
- Run relevant checks (init.sh, tests) when available.
- If gaps exist, add new tasks to task_list.json or reopen existing tasks.
- If everything matches the spec, do not add tasks.

STRICT RULES:
- Do NOT change product code. Only update task_list.json and claude-progress.txt.
- Be concrete: each task must have clear steps to verify.
- Avoid duplicates; reuse/reopen existing tasks when appropriate.
- Ensure any new task id is unique within task_list.json; if it collides, reopen or choose a new id.

At the end:
- Append a brief entry to claude-progress.txt summarizing the audit.
- Commit changes with a message like "Spec audit: <brief summary>".
`;
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
   * INTERNAL: Run a query and capture the session ID for potential resume.
   * Returns the session ID and success status.
   */
  private async runQueryWithSessionCapture(
    prompt: string,
    options: Options,
    phase: HarnessPhase
  ): Promise<SessionResult> {
    const stream = query({ prompt, options });
    let lastResult: SDKMessage | null = null;
    let sessionId: string | null = null;

    for await (const msg of stream) {
      this.defaultLogMessage(msg, phase);
      this.cfg.onMessage?.(msg, phase);

      // Capture session ID from any message
      if ("session_id" in msg && msg.session_id && !sessionId) {
        sessionId = msg.session_id;
      }

      if (msg.type === "result") {
        lastResult = msg;
      }
    }

    const success = lastResult?.type === "result" && lastResult.subtype === "success";
    const errorSubtype = lastResult?.type === "result" ? lastResult.subtype : undefined;
    const errors = lastResult?.type === "result" ? lastResult.errors ?? [] : undefined;
    log("Harness", `[${phase}] Session ended. success=${success}, lastResult.type=${lastResult?.type}, lastResult.subtype=${(lastResult as any)?.subtype}`);
    return { sessionId, success, errors, errorSubtype };
  }

  /**
   * INTERNAL: Resume a previous session with a new prompt.
   */
  private async resumeSession(
    sessionId: string,
    prompt: string,
    options: Options,
    phase: HarnessPhase
  ): Promise<SessionResult> {
    const resumeOptions: Options = {
      ...options,
      resume: sessionId,
    };
    return this.runQueryWithSessionCapture(prompt, resumeOptions, phase);
  }

  /**
   * INTERNAL: Run the review agent and parse its findings.
   */
  private async runReviewAgent(
    task: TaskSpec,
    options: Options,
    existingSessionId: string | null,
    workerMode: boolean
  ): Promise<ReviewResult> {
    const reviewPrompt = existingSessionId
      ? (workerMode ? this.buildReviewContinuationPromptForWorker(task) : this.buildReviewContinuationPrompt(task))
      : (workerMode ? this.buildReviewPromptForWorker(task) : this.buildReviewPrompt(task));

    const reviewOptions: Options = {
      ...options,
      maxTurns: this.cfg.maxReviewTurns ?? 100,
      ...(existingSessionId ? { resume: existingSessionId } : {}),
    };

    const stream = query({ prompt: reviewPrompt, options: reviewOptions });
    let sessionId: string | null = existingSessionId;
    let lastAssistantText = "";

    for await (const msg of stream) {
      this.defaultLogMessage(msg, "review");
      this.cfg.onMessage?.(msg, "review");

      if ("session_id" in msg && msg.session_id && !sessionId) {
        sessionId = msg.session_id;
      }

      // Capture assistant text for parsing review result
      if (msg.type === "assistant") {
        const content = (msg.message as any).content ?? [];
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") {
            lastAssistantText += block.text + "\n";
          }
        }
      }
    }

    // Parse review result from assistant output
    const { passed, issues } = this.parseReviewResult(lastAssistantText);
    const issuesPath = passed ? null : await this.writeReviewIssues(task, issues, "claude");

    return { sessionId, passed, issues, issuesPath };
  }

  /**
   * INTERNAL: Parse the review agent's output to determine pass/fail.
   * Uses the LAST occurrence of REVIEW_RESULT since prompts may be echoed.
   */
  private parseReviewResult(text: string): { passed: boolean; issues: string[] } {
    const sentinelMatches = [...text.matchAll(/<<<CODEX_REVIEW_RESULT:([a-zA-Z0-9-]+)>>>\s*([\s\S]*?)\s*<<<END_CODEX_REVIEW_RESULT:\1>>>/g)];
    if (sentinelMatches.length > 0) {
      const lastSentinel = sentinelMatches[sentinelMatches.length - 1];
      const payloadRaw = (lastSentinel[2] ?? "").trim();
      try {
        const payload = JSON.parse(payloadRaw);
        const result =
          typeof payload?.result === "string"
            ? payload.result.trim().toUpperCase()
            : "";
        if (result === "PASS") {
          return { passed: true, issues: [] };
        }
        if (result === "FAIL") {
          const issues = Array.isArray(payload?.issues)
            ? payload.issues.map((issue: unknown) => String(issue)).filter((issue: string) => issue.trim().length > 0)
            : [];
          return { passed: false, issues: issues.length > 0 ? issues : ["Review failed (no specific issues listed)"] };
        }
      } catch {
        // Fall through to legacy parsing.
      }
    }

    // Find ALL occurrences of REVIEW_RESULT and use the LAST one
    // (prompts contain FAIL as an example, actual result comes at the end)
    const resultMatches = [...text.matchAll(/REVIEW_RESULT:\s*(PASS|FAIL)/gi)];

    if (resultMatches.length > 0) {
      const lastMatch = resultMatches[resultMatches.length - 1];
      const verdict = lastMatch[1].toUpperCase();

      if (verdict === "PASS") {
        return { passed: true, issues: [] };
      }

      // FAIL - extract issues from text AFTER the last REVIEW_RESULT: FAIL
      const issues: string[] = [];
      const matchIndex = lastMatch.index ?? text.lastIndexOf("REVIEW_RESULT:");
      const textAfterVerdict = text.slice(matchIndex);

      const issuesSection = textAfterVerdict.match(/\*?\*?ISSUES:?\*?\*?\s*([\s\S]*?)(?=VERIFIED|REVIEW_RESULT|$)/i);
      if (issuesSection) {
        const content = issuesSection[1];
        const issueLines = content.split("\n").filter((line) => {
          const trimmed = line.trim();
          return trimmed.startsWith("-") || /^\d+[\.\)]\s/.test(trimmed) || trimmed.startsWith("*");
        });
        for (const line of issueLines) {
          const cleaned = line
            .replace(/^[\s\-\*]+/, "")
            .replace(/^\d+[\.\)]\s*/, "")
            .replace(/\*\*/g, "")
            .trim();
          if (cleaned.length > 0) {
            issues.push(cleaned);
          }
        }
      }
      return { passed: false, issues: issues.length > 0 ? issues : ["Review failed (no specific issues listed)"] };
    }

    // No explicit markers - look for problem indicators
    // Use custom patterns if provided, otherwise use defaults
    const customPatterns = this.cfg.prompts?.redFlagPatterns;
    if (customPatterns !== undefined) {
      // Custom patterns provided (may be empty array to disable detection)
      for (const patternStr of customPatterns) {
        const pattern = new RegExp(patternStr, "i");
        if (pattern.test(text)) {
          return { passed: false, issues: ["Review found potential issues (no explicit PASS)"] };
        }
      }
    } else {
      // Default code-focused patterns
      const defaultIndicators = [
        /\#\[ignore\]/i,
        /stub|placeholder|todo|fixme/i,
        /not actually (test|run|verify)/i,
        /tests? (are |were )?ignored/i,
        /--no-run/i,
      ];
      for (const pattern of defaultIndicators) {
        if (pattern.test(text)) {
          return { passed: false, issues: ["Review found potential issues (no explicit PASS)"] };
        }
      }
    }

    // Default to fail if no clear result
    return { passed: false, issues: ["No explicit REVIEW_RESULT found"] };
  }

  private isPromptTooLong(result: SessionResult): boolean {
    const errors = result.errors ?? [];
    if (errors.length === 0) {
      return false;
    }
    const combined = errors.join(" ").toLowerCase();
    return (
      combined.includes("prompt is too long") ||
      combined.includes("context length") ||
      combined.includes("maximum context") ||
      combined.includes("max tokens") ||
      combined.includes("too many tokens") ||
      combined.includes("prompt too large")
    );
  }

  private async writeReviewIssues(
    task: TaskSpec,
    issues: string[],
    source: "codex" | "claude"
  ): Promise<string | null> {
    if (issues.length === 0) {
      return null;
    }
    if (!(await pathExists(this.paths.gitDir))) {
      return null;
    }

    const reviewDir = path.join(this.paths.gitDir, "looper-review");
    const issuesPath = path.join(reviewDir, "issues.txt");
    const content = [
      `Task: ${task.id}`,
      `Source: ${source}`,
      `Timestamp: ${new Date().toISOString()}`,
      "",
      "Issues:",
      ...issues.map((issue) => `- ${issue}`),
      "",
    ].join("\n");

    try {
      await fs.mkdir(reviewDir, { recursive: true });
      await fs.writeFile(issuesPath, content, "utf8");
      log("Harness", `Saved review issues to ${issuesPath}`);
      return issuesPath;
    } catch (err) {
      console.warn("[Harness] Failed to write review issues file:", err);
      return null;
    }
  }

  /**
   * INTERNAL: Run Codex CLI for code review.
   * Executes `codex exec` with a review prompt and parses the output.
   */
  private async runCodexReview(
    task: TaskSpec,
    isRerun: boolean,
    workerMode: boolean
  ): Promise<ReviewResult> {
    const reviewNonce = randomUUID();
    const prompt = isRerun
      ? this.buildCodexReviewContinuationPrompt(task, reviewNonce, workerMode)
      : this.buildCodexReviewPrompt(task, reviewNonce, workerMode);

    const model = this.cfg.codexModel;
    log("Harness", `Running Codex CLI review (model=${model ?? "default"}, task=${task.id})`);

    const args = ["exec"];
    if (model) {
      args.push("-m", model);
    }
    // Use --dangerously-bypass-approvals-and-sandbox since Modal is already sandboxed
    args.push("--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", prompt);

    return new Promise((resolve) => {
      const proc = spawn("codex", args, {
        cwd: this.workingDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(this.workingDir, ".git"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      // Filter to only log interesting lines (not full diffs/command output)
      const shouldLog = (line: string): boolean => {
        const trimmed = line.trim();
        if (!trimmed) return false;
        // Always show these
        if (trimmed.startsWith("thinking")) return true;
        if (trimmed.startsWith("**")) return true;  // thinking summaries
        if (trimmed.includes("REVIEW_RESULT")) return true;
        if (trimmed.includes("ISSUES:") || trimmed.includes("VERIFIED:")) return true;
        if (trimmed.startsWith("- ") && stdout.includes("ISSUES:")) return true;  // issue list items
        if (trimmed.includes("error") || trimmed.includes("Error")) return true;
        // Show exec commands but not their output
        if (trimmed === "exec") return true;
        if (trimmed.startsWith("/bin/bash")) return true;
        if (trimmed.includes("succeeded in") || trimmed.includes("failed in")) return true;
        // Skip diff lines, file content, etc.
        return false;
      };

      proc.stdout.on("data", (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        for (const line of text.split("\n")) {
          if (shouldLog(line)) {
            log("review", `codex: ${line.trim()}`);
          }
        }
      });

      proc.stderr.on("data", (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        for (const line of text.split("\n")) {
          if (shouldLog(line)) {
            log("review", `codex: ${line.trim()}`);
          }
        }
      });

      proc.on("close", (code) => {
        void (async () => {
          if (code !== 0) {
            console.error(`[Harness] Codex CLI exited with code ${code}`);
          }

          // Parse the review result from codex output
          const { passed, issues } = this.parseReviewResult(stdout + stderr);
          const issuesPath = passed ? null : await this.writeReviewIssues(task, issues, "codex");

          resolve({ sessionId: null, passed, issues, issuesPath });
        })();
      });

      proc.on("error", (err) => {
        console.error(`[Harness] Codex CLI spawn error: ${err.message}`);
        resolve({
          sessionId: null,
          passed: false,
          issues: [`Codex CLI spawn failed: ${err.message}`],
        });
      });
    });
  }

  /**
   * Build the Codex review prompt for initial review.
   */
  private buildCodexReviewPrompt(task: TaskSpec, reviewNonce: string, workerMode: boolean): string {
    const coordinationNote = workerMode
      ? "Do NOT update task_list.json or claude-progress.txt. The controller handles coordination."
      : "If PASS, you must update task_list.json and claude-progress.txt as described below.";
    return `You are a CODE REVIEWER auditing work on task: "${task.id}"

Task description: ${task.description}

IMPORTANT: The working agent has left changes UNCOMMITTED for you to review.
The working agent already ran tests. Trust their results unless the code looks broken.

REVIEW CHECKLIST:

1. Check what changed: git status && git diff

2. Verify the implementation meets the task description

3. Look for obvious issues (bugs, missing error handling, incomplete implementation)

REVIEW GUIDELINES:
- Focus on correctness: does the code do what the task asks?
- Fix minor issues yourself (typos, imports) rather than failing
- Only re-run tests if code looks suspicious

${coordinationNote}

${this.buildCodexReviewOutputFormat(task.id, reviewNonce, workerMode)}

Begin your audit now.`;
  }

  /**
   * Build the Codex review prompt for re-review after fixes.
   */
  private buildCodexReviewContinuationPrompt(task: TaskSpec, reviewNonce: string, workerMode: boolean): string {
    const coordinationNote = workerMode
      ? "Do NOT update task_list.json or claude-progress.txt. The controller handles coordination."
      : "If PASS, you must update task_list.json and claude-progress.txt as described below.";
    return `The working agent claims to have fixed the issues you identified for task "${task.id}".

IMPORTANT: Changes are UNCOMMITTED. Check staged/unstaged changes, not commits.

Re-verify:
1. Run: git status and git diff to see current changes
2. Check if each issue you raised has been addressed
3. Look for any NEW issues introduced by the fixes

Same guidelines: trust tests ran, fix minor issues yourself, only re-run if suspicious.

${coordinationNote}

${this.buildCodexReviewOutputFormat(task.id, reviewNonce, workerMode)}`;
  }

  private buildCodexReviewOutputFormat(taskId: string, reviewNonce: string, workerMode: boolean): string {
    const passActions = workerMode
      ? `If PASS, you MUST:
1. Do NOT edit task_list.json or claude-progress.txt
2. Stage ALL changes: git add -A
3. Commit code changes with message: "Task ${taskId}: <brief description>"`
      : `If PASS, you MUST:
1. Update task_list.json: set "passes": true for "${taskId}"
2. Append to claude-progress.txt with a brief entry
3. Stage ALL changes: git add -A
4. Commit with message: "Complete ${taskId}: <brief description>"`;
    return `OUTPUT FORMAT (MACHINE READABLE ONLY):

Return EXACTLY one block with valid JSON between the markers. Do not include any other text.

<<<CODEX_REVIEW_RESULT:${reviewNonce}>>>
{"result":"<PASS|FAIL>","issues":["<issue with file:line reference>"],"verified":["<what you verified>"],"tests":["<tests you ran>"]}
<<<END_CODEX_REVIEW_RESULT:${reviewNonce}>>>

${passActions}`;
  }

  /**
   * Ensure local working directory matches the remote GitHub repository if configured.
   * Clones when missing; otherwise fetches + hard resets to origin/<branch>.
   * Handles empty repos by initializing them locally first.
   */
  private async syncRepoFromRemote(): Promise<void> {
    log("Harness", `Syncing from remote: ${this.repositoryUrl} (branch: ${this.branch})`);
    await this.ensureRemoteRepoExists();
    const repoExists = await pathExists(this.paths.gitDir);

    // Clean up stale git lock files that may remain from crashed sandboxes
    if (repoExists) {
      const gitDir = path.join(this.workingDir, ".git");
      try {
        const files = await fs.readdir(gitDir);
        for (const file of files) {
          if (file.endsWith(".lock")) {
            await fs.rm(path.join(gitDir, file), { force: true });
          }
        }
      } catch {
        // Ignore - directory may not exist or be readable
      }
    }

    const env = this.buildGitEnv();
    const branchRef = this.branch;
    const authUrl = this.getAuthenticatedRepoUrl();

    if (!repoExists) {
      log("Harness", `No local repo at ${this.workingDir}, cloning...`);
      await fs.mkdir(this.workingDir, { recursive: true });

      // Try to clone; if it fails due to empty repo, initialize locally
      try {
        await this.execGit(
          ["clone", "--branch", branchRef, "--single-branch", authUrl, this.workingDir],
          env
        );
        // Set the remote to the non-authenticated URL for display purposes
        await this.execGit(["-C", this.workingDir, "remote", "set-url", "origin", this.repositoryUrl], env);
        log("Harness", `✓ Cloned repository successfully`);
        return;
      } catch (err: any) {
        const msg = err?.message ?? "";
        // Handle empty repo (no branches yet)
        if (msg.includes("Remote branch") && msg.includes("not found")) {
          log("Harness", "Remote repo is empty, initializing locally...");
          await execFileAsync("git", ["init"], { cwd: this.workingDir, env });
          await execFileAsync("git", ["remote", "add", "origin", this.repositoryUrl], { cwd: this.workingDir, env });
          await execFileAsync("git", ["checkout", "-b", branchRef], { cwd: this.workingDir, env });
          log("Harness", `✓ Initialized empty local repo`);
          return;
        }
        throw err;
      }
    }

    log("Harness", `Local repo exists, fetching and resetting to origin/${branchRef}...`);
    // Update remote URL to authenticated version for fetch
    await this.execGit(["-C", this.workingDir, "remote", "set-url", "origin", authUrl], env);
    try {
      await this.execGit(["-C", this.workingDir, "fetch", "origin", branchRef], env);
      await this.execGit(["-C", this.workingDir, "checkout", "-B", branchRef, `origin/${branchRef}`], env);
      await this.execGit(["-C", this.workingDir, "reset", "--hard", `origin/${branchRef}`], env);
      await this.execGit(["-C", this.workingDir, "clean", "-fd"], env);
      log("Harness", `✓ Synced to origin/${branchRef}`);
    } catch (err: any) {
      const msg = err?.message ?? "";
      // Handle case where remote branch doesn't exist yet (empty repo)
      if (
        msg.includes("couldn't find remote ref") ||
        msg.includes("unknown revision") ||
        msg.includes("not a commit") ||
        msg.includes("pathspec")
      ) {
        log("Harness", "Remote branch doesn't exist yet, using local state...");
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
    log("Harness", `git ${redactedArgs.join(" ")}`);
    try {
      const result = await execFileAsync("git", args, { env });
      const stdout = result.stdout?.toString().trim();
      if (stdout) {
        log("Harness", `git output: ${stdout.substring(0, 200)}${stdout.length > 200 ? "..." : ""}`);
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
    log("Harness", `Checking for unpushed commits (${phase})...`);
    const needsToken = this.requiresGithubToken(this.repositoryUrl);
    if (needsToken && !this.gitToken) {
      throw new Error(
        `[Harness] GITHUB_TOKEN is required to push changes to ${this.repositoryUrl}. Provide a token with repo scope before running ${phase}.`
      );
    }

    const env = this.buildGitEnv();

    // Check for uncommitted changes and auto-commit if needed
    try {
      const status = await execFileAsync("git", ["-C", this.workingDir, "status", "--porcelain"], { env });
      const uncommitted = status.stdout.trim();
      if (uncommitted) {
        console.warn(`[Harness] Found uncommitted changes, auto-committing...`);
        await execFileAsync("git", ["-C", this.workingDir, "add", "-A"], { env });
        await execFileAsync("git", ["-C", this.workingDir, "commit", "-m", `Auto-commit uncommitted changes (${phase})`], { env });
        log("Harness", `Auto-committed uncommitted changes`);
      }
    } catch (err) {
      console.warn(`[Harness] Failed to check/commit uncommitted changes:`, err instanceof Error ? err.message : err);
    }

    // Check if there are any commits at all
    let headSha: string | null = null;
    try {
      const result = await execFileAsync("git", ["-C", this.workingDir, "rev-parse", "HEAD"], { env });
      headSha = result.stdout.trim();
      log("Harness", `Current HEAD: ${headSha}`);
    } catch {
      log("Harness", `No commits yet, nothing to push.`);
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
      log("Harness", `Unpushed commits: ${unpushedCommits.length}`);
      for (const commit of unpushedCommits) {
        log("Harness", `  - ${commit}`);
      }
    } catch {
      // origin/<branch> doesn't exist yet, so all local commits are unpushed
      log("Harness", `Remote branch origin/${this.branch} not found, all commits are unpushed`);
      unpushedCommits = ["all"];
    }

    if (unpushedCommits.length === 0) {
      log("Harness", `No unpushed commits after ${phase} phase.`);
      return;
    }

    // Pull (rebase) then push to origin
    const authUrl = this.getAuthenticatedRepoUrl();
    log("Harness", `Pushing to origin/${this.branch}...`);
    try {
      // First, try to pull with rebase in case remote has new commits
      try {
        log("Harness", `Attempting pull --rebase first...`);
        await this.execGit(["-C", this.workingDir, "pull", "--rebase", authUrl, this.branch], env);
      } catch (pullErr) {
        // Pull may fail if remote branch doesn't exist yet, that's OK
        log("Harness", `Pull --rebase skipped or failed (may be expected): ${pullErr instanceof Error ? pullErr.message : pullErr}`);
      }
      // Use -u to set upstream if this is the first push
      log("Harness", `Executing push...`);
      await this.execGit(["-C", this.workingDir, "push", "-u", authUrl, this.branch], env);
      log("Harness", `✓ Successfully pushed ${unpushedCommits.length} commit(s) to origin/${this.branch} (${phase}).`);
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
- To kill a specific process: pkill -f "specific-process-name"

CRITICAL WARNING - FILE SIZE LIMITS:
- The Read tool has a 25,000 token limit (~100KB). Large source files WILL cause errors.
- For large files: Use the "offset" and "limit" parameters to read specific portions
- Prefer using Grep to search for specific patterns instead of reading entire files
- When editing large files, use Edit tool which works on specific sections`;

    if (phase === "planning") {
      return `You are the PLANNING agent for a Looper-managed project.
Your PRIMARY job is to create a COMPREHENSIVE task list that covers EVERYTHING
in the project spec. Do NOT implement any tasks or scaffold the project.
Project setup is the FIRST task in the list for a working agent to implement.
Create coordination artifacts (task_list.json, claude-progress.txt, init.sh,
CLAUDE.md) for future working agents. Work on branch ${this.branch}.
${envInfo}`;
    }

    if (phase === "review") {
      return `You are an independent CODE REVIEWER auditing work done by another agent.
You have NO context of how the code was implemented. Your job is to find problems,
verify tests actually run and pass, and catch cheating patterns like ignored tests
or stub implementations. Be skeptical. Work on branch ${this.branch}.
${envInfo}`;
    }

    if (phase === "audit") {
      return `You are a SPEC AUDITOR for a Looper-managed project.
Your job is to check whether the implementation matches the project spec.
Only update coordination artifacts (task_list.json, claude-progress.txt).
Do NOT change product code. Work on branch ${this.branch}.
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
      - "depends_on": optional list of prerequisite task ids (be explicit when tasks can run in parallel)
      - "scope": optional list of paths or areas this task is likely to touch (for conflict avoidance)
   - Be EXHAUSTIVE. Every task, behavior, and capability in the spec must have
     a corresponding entry. If the spec mentions it, there should be a task for it.
   - Include both happy paths AND error cases where the spec implies them.
   - Order tasks roughly by dependency (setup first, then core tasks, then polish).

3) Create claude-progress.txt at the repo root
   - Start a running log for future agents.
   - Keep it concise (under 20 lines). Include:
       - Brief summary of project requirements.
       - Total number of tasks identified.
       - Recommended approach/architecture (high-level only).
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

6) Copy the project spec to SPEC.md at the repo root
   - Run: cp /harness/spec.txt SPEC.md
   - This allows future working agents to reference detailed requirements.
   - Do NOT write it manually — just copy the file.

7) Initialize git
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
  private buildWorkingPrompt(isProjectSetup: boolean, task?: TaskSpec): string {
    const taskAssignment = task && !isProjectSetup
      ? `
═══════════════════════════════════════════════════════════════════════════════
ASSIGNED TASK: ${task.id}
Category: ${task.category}
Description: ${task.description}
Steps to verify:
${task.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}
═══════════════════════════════════════════════════════════════════════════════

You MUST work on this specific task. Do NOT choose a different task.
`
      : "";

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
     * Do NOT mark any tasks as passing while the environment is broken.
   - Once init.sh starts successfully, proceed with your task.
`;

    return `
You are a working agent on a long-running project.

Multiple agents will work on this repo across many sessions. You do not have
access to their conversations; you only see the repo, scripts, tests, and
git history.
${taskAssignment}${projectSetupSection}
Key coordination artifacts (ALL at repo root):
- CLAUDE.md — project context and guidelines (read this first).
- SPEC.md — the FULL original project specification (reference for detailed requirements).
- task_list.json — list of end-to-end tasks with a "passes" flag.
- claude-progress.txt — log of previous work and instructions.
- init.sh — script to start the environment and run smoke tests.
- git log — history of previous changes.

NOTE: Coordination artifacts (task_list.json, claude-progress.txt, init.sh) go at repo root.
Project source code goes in appropriate subdirectories (src/, backend/, frontend/, etc.).

Your job in this session is to:
  1. Get oriented.
  2. ${task ? "Confirm your assigned task (see above)." : "Find the first failing task in task_list.json."}
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

2) ${task ? `Confirm your assigned task: "${task.id}"
   - Your task is already specified above. Do NOT pick a different task.
   - Review the task description and verification steps.
   - Work on THIS task only in this session.` : `Choose a task
   - Find the highest-priority task whose "passes" flag is false.
   - Tasks are ordered by dependency—work from top to bottom.
   - Work on ONE task only in this session.`}
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

${isProjectSetup ? "5" : "6"}) Verify your work
${this.cfg.prompts?.verificationCriteria ?? `   - Exercise the full user flow described by that task's "steps".
   - Use browser automation or HTTP calls if the tools are available, and
     complement them with unit or integration tests where helpful.
   - Fix any bugs you find and re-run tests as needed.`}

${this.cfg.prompts?.completionCriteria ? `
${isProjectSetup ? "6" : "7"}) Additional completion criteria
${this.cfg.prompts.completionCriteria}

${isProjectSetup ? "7" : "8"}) Update coordination artifacts ONLY when the task truly works` : `${isProjectSetup ? "6" : "7"}) Update coordination artifacts ONLY when the task truly works`}
   - In task_list.json:
       - Set "passes": true for the completed task.
       - Do NOT edit "category", "description", or "steps" unless you are fixing an objectively incorrect test (e.g., the product requirements changed).
       - It is unacceptable to delete or weaken tests just to make a task appear passing.
       - Do not remove or rename other tasks.
   - In claude-progress.txt:
       - Append a BRIEF entry (aim for 3-5 lines) noting:
           - Which task you worked on (by id).
           - Key files changed.
           - How you verified it works.
           - Any blockers or TODOs for future agents.
       - Be concise—future agents skim this log, they don't read essays.

${isProjectSetup ? "7" : "8"}) Commit your work
   - Run tests and ./init.sh to verify everything works (must pass fully).
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
- If you hit a blocker (library issues, missing APIs, unclear errors), create an
  investigation task and move on. Don't abandon libraries for hacky workarounds.
- If you discover missing features/prerequisites: fix them now if feasible, otherwise
  add them as new tasks in task_list.json with "passes": false and move on.
  Ensure new task ids do not collide with existing ones; reopen or rename if needed.
- Do NOT redefine task requirements to claim success:
    * "Identical failures" is NOT "identical behavior" - things must actually work
    * If a task says "produce and consume records", records must actually be produced and consumed
    * If you can't make it work, mark the task as failing - don't rationalize that broken = complete

Throughout your response:
- Explain what you are doing and why.
- When you change files, mention them explicitly.
- When you test behavior, describe the exact commands or steps you ran.

Begin by summarizing what you see in the repo and which task you plan to tackle.
`;
  }

  /**
   * Build the working prompt for review mode - implementation without marking complete.
   */
  private buildWorkingPromptForReview(isProjectSetup: boolean, task: TaskSpec): string {
    const basePrompt = this.buildWorkingPrompt(isProjectSetup, task);

    // Append a strong override at the end - more robust than regex replacement
    return `${basePrompt}

═══════════════════════════════════════════════════════════════════════════════
CRITICAL OVERRIDE - REVIEW MODE ACTIVE
═══════════════════════════════════════════════════════════════════════════════
You are in REVIEW MODE. A separate review agent will audit your work.

DO NOT:
- Update task_list.json to set "passes": true
- Write to claude-progress.txt
- Mark the task as complete in any way
- Run "git commit" - leave your changes UNCOMMITTED

DO:
- Implement the task fully
- Run tests and verify they pass
- Stage your changes with "git add" but DO NOT COMMIT
- The review agent will verify, update task_list.json, and commit everything together
═══════════════════════════════════════════════════════════════════════════════`;
  }

  /**
   * Build the working prompt for parallel worker + review mode.
   * The worker must implement without touching coordination artifacts.
   */
  private buildWorkingPromptForWorkerReview(isProjectSetup: boolean, task: TaskSpec): string {
    const basePrompt = this.buildWorkingPrompt(isProjectSetup, task);

    return `${basePrompt}

═══════════════════════════════════════════════════════════════════════════════
CRITICAL OVERRIDE - PARALLEL WORKER REVIEW MODE
═══════════════════════════════════════════════════════════════════════════════
You are running as a parallel worker with review enabled.
The controller handles coordination artifacts and final task completion.

DO NOT:
- Update task_list.json to set "passes": true
- Write to claude-progress.txt
- Modify or reformat coordination artifacts
- Run "git commit" or "git push" (leave changes UNCOMMITTED)

DO:
- Implement the task fully
- Run tests and verify they pass
- Stage your changes with "git add -A"
- Leave the commit to the review agent
═══════════════════════════════════════════════════════════════════════════════`;
  }

  /**
   * Build the working prompt for parallel worker mode.
   * The worker must implement and commit code but must NOT update coordination artifacts.
   */
  private buildWorkingPromptForWorker(isProjectSetup: boolean, task: TaskSpec): string {
    const basePrompt = this.buildWorkingPrompt(isProjectSetup, task);

    return `${basePrompt}

═══════════════════════════════════════════════════════════════════════════════
CRITICAL OVERRIDE - PARALLEL WORKER MODE
═══════════════════════════════════════════════════════════════════════════════
You are running as a parallel worker. The controller will update coordination
artifacts and mark tasks complete.

DO NOT:
- Update task_list.json to set "passes": true
- Write to claude-progress.txt
- Modify or reformat coordination artifacts

DO:
- Implement the task fully
- Run tests and verify they pass
- Commit your code changes with a focused message
═══════════════════════════════════════════════════════════════════════════════`;
  }

  /**
   * Prompt for fixing issues found by the review agent.
   */
  private buildFixPrompt(issues: string[], issuesPath?: string | null): string {
    const maxIssues = 10;
    const shownIssues = issues.slice(0, maxIssues);
    const issueList = shownIssues.map((issue, i) => `${i + 1}. ${issue}`).join("\n");
    const remainingCount = issues.length - shownIssues.length;
    const extraNote =
      remainingCount > 0
        ? `\n(+${remainingCount} more${issuesPath ? `; see ${issuesPath}` : ""})`
        : "";
    const fileNote = issuesPath ? `\nFull issue list saved at: ${issuesPath}` : "";

    return `
The code review found the following issues with your implementation:

${issueList}${extraNote}${fileNote}

You must fix ALL of these issues. The review agent will verify each fix.

Rules:
- DO NOT ask questions or present options - just do the work
- Actually fix the issues, don't just dismiss them or work around them
- If a test needs to run, make it run (set up dependencies, don't just #[ignore] it)
- If something is a stub, implement it fully
- If tests are marked #[ignore], remove the ignore and make them pass
- Show your work: run the tests, show they pass
- Do NOT redefine requirements to claim success (e.g., "identical failures = identical behavior")
- If code doesn't work, fix it or mark the task as failing - don't rationalize

If you discover missing prerequisites: fix them now if feasible, otherwise add them
as new tasks with "passes": false and move on to something you can complete.
Ensure new task ids do not collide with existing ones; reopen or rename if needed.

After completing your work:
- Stage your changes with "git add" but DO NOT COMMIT
- The review agent will verify and commit everything together if it passes
`;
  }

  /**
   * Prompt for fixing issues in parallel worker + review mode.
   */
  private buildFixPromptForWorker(issues: string[], issuesPath?: string | null): string {
    const basePrompt = this.buildFixPrompt(issues, issuesPath);
    return `${basePrompt}

Additional constraints for parallel worker review mode:
- Do NOT update task_list.json or claude-progress.txt
- Do NOT create new coordination tasks in task_list.json; report blockers in your response instead
- Leave changes staged but UNCOMMITTED for the review agent
`;
  }

  /**
   * Prompt for the review agent (fresh context, adversarial).
   */
  private buildReviewPrompt(task: TaskSpec): string {
    const customChecklist = this.cfg.prompts?.reviewChecklist;

    if (customChecklist) {
      // Use custom domain-specific review prompt
      return `
You are an independent REVIEWER auditing work on task: "${task.id}"

Task description: ${task.description}

You have NO context of how this was done. You must verify independently.

IMPORTANT: The working agent has left changes UNCOMMITTED for you to review.
You will see staged/unstaged changes, not commits.

YOUR JOB IS TO FIND PROBLEMS. Be skeptical.

${customChecklist}

OUTPUT FORMAT (you MUST use this exact format at the end):

If issues found:
REVIEW_RESULT: FAIL
ISSUES:
- <issue 1 with reference>
- <issue 2 with reference>
...

If everything passes:
REVIEW_RESULT: PASS
VERIFIED:
- <what you verified>

Then, if PASS, you MUST do ALL of the following in ONE ATOMIC COMMIT:
1. Update task_list.json: set "passes": true for "${task.id}"
2. Append to claude-progress.txt with a brief entry noting the task was reviewed and approved
3. Stage ALL changes: git add -A
4. Commit EVERYTHING together with message:
   "Complete ${task.id}: <brief description>"

Begin your review now.
`;
    }

    // Default code-focused review prompt
    return `
You are an independent CODE REVIEWER auditing work on task: "${task.id}"

Task description: ${task.description}

You have NO context of how this was implemented. You must verify independently.

IMPORTANT: The working agent has left changes UNCOMMITTED for you to review.
You will see staged/unstaged changes, not commits.

YOUR JOB IS TO FIND PROBLEMS. Be skeptical. Assume the implementation may be:
- Incomplete (stubs, placeholders, TODOs left in code)
- Untested (tests don't actually run, are ignored, or don't verify behavior)
- Gaming metrics (marking things complete without real verification)

AUDIT CHECKLIST:

1. Check what changed (the working agent left changes uncommitted):
   - Run: git status
   - Run: git diff --stat
   - Run: git diff (for unstaged) and git diff --cached (for staged)

2. Look for cheating patterns:
   - Run: grep -r "#\\[ignore\\]" on test files (tests that are skipped)
   - Run: grep -r "TODO\\|FIXME\\|unimplemented\\|todo!" on changed files
   - Check if tests use "--no-run" (compilation only, no execution)

3. Actually run the tests:
   - Find and run the relevant test command (cargo test, npm test, pytest, etc.)
   - Verify tests ACTUALLY EXECUTE (not just compile)
   - Check the output shows tests running and passing

4. Verify the implementation:
   - Does the code actually do what the task description says?
   - Are there stub/placeholder implementations?
   - Is error handling real or just "// TODO: handle errors"?

5. Check for deferred work:
   - "Ready to run" but never actually run
   - "Infrastructure complete" but no actual functionality
   - Tests that test infrastructure, not behavior

RED FLAGS (automatic fail):
- Tests marked #[ignore] that should run
- "cargo test --no-run" used as verification
- Stub implementations (unimplemented!(), todo!(), pass, ...)
- TODOs in the implementation code
- Tests that don't assert anything meaningful
- "This will be implemented later" comments
- Abandoning proper libraries for manual implementations without justification
  (e.g., "had version issues" so switched to manual byte encoding)
- Using old/deprecated API versions when modern ones should work
- Redefining task requirements to claim success (e.g., "identical failures count as identical behavior")
- Rationalizing that broken code meets requirements through creative interpretation

OUTPUT FORMAT (you MUST use this exact format at the end):

If issues found:
REVIEW_RESULT: FAIL
ISSUES:
- <issue 1 with file:line reference>
- <issue 2 with file:line reference>
...

If everything passes:
REVIEW_RESULT: PASS
VERIFIED:
- <what you verified>
- <tests you ran and their output>

Then, if PASS, you MUST do ALL of the following in ONE ATOMIC COMMIT:
1. Update task_list.json: set "passes": true for "${task.id}"
2. Append to claude-progress.txt with a brief entry noting the task was reviewed and approved
3. Stage ALL changes: git add -A
4. Commit EVERYTHING together (implementation + task updates) with message:
   "Complete ${task.id}: <brief description of what was implemented>"

This ensures the implementation and task completion are in ONE commit, not separate commits.

Begin your audit now.
`;
  }

  /**
   * Prompt for the review agent in parallel worker mode (no coordination updates).
   */
  private buildReviewPromptForWorker(task: TaskSpec): string {
    const customChecklist = this.cfg.prompts?.reviewChecklist;

    if (customChecklist) {
      return `
You are an independent REVIEWER auditing work on task: "${task.id}"

Task description: ${task.description}

You have NO context of how this was done. You must verify independently.

IMPORTANT: The working agent has left changes UNCOMMITTED for you to review.
You will see staged/unstaged changes, not commits.

YOUR JOB IS TO FIND PROBLEMS. Be skeptical.

${customChecklist}

OUTPUT FORMAT (you MUST use this exact format at the end):

If issues found:
REVIEW_RESULT: FAIL
ISSUES:
- <issue 1 with reference>
- <issue 2 with reference>
...

If everything passes:
REVIEW_RESULT: PASS
VERIFIED:
- <what you verified>

Then, if PASS, you MUST do ALL of the following in ONE ATOMIC COMMIT:
1. Do NOT update task_list.json or claude-progress.txt (controller handles it)
2. Stage ALL changes: git add -A
3. Commit code changes with message:
   "Task ${task.id}: <brief description>"

Begin your review now.
`;
    }

    return `
You are an independent CODE REVIEWER auditing work on task: "${task.id}"

Task description: ${task.description}

You have NO context of how this was implemented. You must verify independently.

IMPORTANT: The working agent has left changes UNCOMMITTED for you to review.
You will see staged/unstaged changes, not commits.

YOUR JOB IS TO FIND PROBLEMS. Be skeptical. Assume the implementation may be:
- Incomplete (stubs, placeholders, TODOs left in code)
- Untested (tests don't actually run, are ignored, or don't verify behavior)
- Gaming metrics (marking things complete without real verification)

AUDIT CHECKLIST:

1. Check what changed (the working agent left changes uncommitted):
   - Run: git status
   - Run: git diff --stat
   - Run: git diff (for unstaged) and git diff --cached (for staged)

2. Look for cheating patterns:
   - Run: grep -r "#\\[ignore\\]" on test files (tests that are skipped)
   - Run: grep -r "TODO\\|FIXME\\|unimplemented\\|todo!" on changed files
   - Check if tests use "--no-run" (compilation only, no execution)

3. Actually run the tests:
   - Find and run the relevant test command (cargo test, npm test, pytest, etc.)
   - Verify tests ACTUALLY EXECUTE (not just compile)
   - Check the output shows tests running and passing

4. Verify the implementation:
   - Does the code actually do what the task description says?
   - Are there stub/placeholder implementations?
   - Is error handling real or just "// TODO: handle errors"?

5. Check for deferred work:
   - "Ready to run" but never actually run
   - "Infrastructure complete" but no actual functionality
   - Tests that test infrastructure, not behavior

RED FLAGS (automatic fail):
- Tests marked #[ignore] that should run
- "cargo test --no-run" used as verification
- Stub implementations (unimplemented!(), todo!(), pass, ...)
- TODOs in the implementation code
- Tests that don't assert anything meaningful
- "This will be implemented later" comments
- Abandoning proper libraries for manual implementations without justification
  (e.g., "had version issues" so switched to manual byte encoding)
- Using old/deprecated API versions when modern ones should work
- Redefining task requirements to claim success (e.g., "identical failures count as identical behavior")
- Rationalizing that broken code meets requirements through creative interpretation

OUTPUT FORMAT (you MUST use this exact format at the end):

If issues found:
REVIEW_RESULT: FAIL
ISSUES:
- <issue 1 with file:line reference>
- <issue 2 with file:line reference>
...

If everything passes:
REVIEW_RESULT: PASS
VERIFIED:
- <what you verified>
- <tests you ran and their output>

Then, if PASS, you MUST do ALL of the following in ONE ATOMIC COMMIT:
1. Do NOT update task_list.json or claude-progress.txt (controller handles it)
2. Stage ALL changes: git add -A
3. Commit code changes with message:
   "Task ${task.id}: <brief description of what was implemented>"

This ensures the implementation is committed for the controller to merge.

Begin your audit now.
`;
  }

  /**
   * Prompt for continuing a review session after fixes.
   */
  private buildReviewContinuationPrompt(task: TaskSpec): string {
    return `
The working agent claims to have fixed the issues you identified.

IMPORTANT: Changes are UNCOMMITTED. Check staged/unstaged changes, not commits.

Re-verify:
1. Run: git status and git diff to see current changes
2. Check if each issue you raised has been addressed
3. Run the tests again to confirm they pass
4. Look for any NEW issues introduced by the fixes

Be thorough. Don't just trust claims - verify independently.

OUTPUT FORMAT:

If issues remain or new issues found:
REVIEW_RESULT: FAIL
ISSUES:
- <remaining/new issue with file:line reference>
...

If ALL issues are fixed:
REVIEW_RESULT: PASS
VERIFIED:
- <what you verified>

If PASS, you MUST do ALL of the following in ONE ATOMIC COMMIT:
1. Update task_list.json: set "passes": true for "${task.id}"
2. Append to claude-progress.txt with a brief entry
3. Stage ALL changes: git add -A
4. Commit EVERYTHING together with message:
   "Complete ${task.id}: <brief description>"
`;
  }

  /**
   * Prompt for continuing a review session after fixes (parallel worker mode).
   */
  private buildReviewContinuationPromptForWorker(task: TaskSpec): string {
    return `
The working agent claims to have fixed the issues you identified.

IMPORTANT: Changes are UNCOMMITTED. Check staged/unstaged changes, not commits.

Re-verify:
1. Run: git status and git diff to see current changes
2. Check if each issue you raised has been addressed
3. Run the tests again to confirm they pass
4. Look for any NEW issues introduced by the fixes

Be thorough. Don't just trust claims - verify independently.

OUTPUT FORMAT:

If issues remain or new issues found:
REVIEW_RESULT: FAIL
ISSUES:
- <remaining/new issue with file:line reference>
...

If ALL issues are fixed:
REVIEW_RESULT: PASS
VERIFIED:
- <what you verified>

If PASS, you MUST do ALL of the following in ONE ATOMIC COMMIT:
1. Do NOT update task_list.json or claude-progress.txt (controller handles it)
2. Stage ALL changes: git add -A
3. Commit code changes with message:
   "Task ${task.id}: <brief description>"
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

  public async readTaskList(): Promise<TaskList> {
    const raw = await fs.readFile(this.paths.taskList, "utf8");
    const data = JSON.parse(raw);

    if (!Array.isArray(data)) {
      throw new Error("task_list.json is not an array");
    }

    const normalized: TaskSpec[] = [];
    const idCounts = new Map<string, number>();

    for (let idx = 0; idx < data.length; idx++) {
      const item = data[idx];
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

      if (record.depends_on !== undefined) {
        if (!Array.isArray(record.depends_on)) {
          throw new Error(`task_list.json entry ${idx} has invalid "depends_on" (must be array)`);
        }
        for (let i = 0; i < record.depends_on.length; i++) {
          if (typeof record.depends_on[i] !== "string") {
            throw new Error(`task_list.json entry ${idx} has non-string depends_on at index ${i}`);
          }
        }
      }

      if (record.scope !== undefined) {
        if (!Array.isArray(record.scope)) {
          throw new Error(`task_list.json entry ${idx} has invalid "scope" (must be array)`);
        }
        for (let i = 0; i < record.scope.length; i++) {
          if (typeof record.scope[i] !== "string") {
            throw new Error(`task_list.json entry ${idx} has non-string scope at index ${i}`);
          }
        }
      }

      const task: TaskSpec = {
        id: record.id,
        category: record.category,
        description: record.description,
        steps: record.steps as string[],
        passes: record.passes as boolean | undefined,
        depends_on: record.depends_on as string[] | undefined,
        scope: record.scope as string[] | undefined,
      };

      normalized.push(task);
      idCounts.set(task.id, (idCounts.get(task.id) ?? 0) + 1);
    }

    const duplicates = [...idCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([id]) => id);

    if (duplicates.length === 0) {
      return normalized;
    }

    console.warn(
      `[Harness] Duplicate task ids detected; using last occurrence for: ${duplicates.join(", ")}`
    );

    const seen = new Set<string>();
    const deduped: TaskSpec[] = [];
    for (let i = normalized.length - 1; i >= 0; i--) {
      const task = normalized[i];
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      deduped.push(task);
    }
    deduped.reverse();
    return deduped;
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
          log(phase, `Session started (model=${msg.model}, permissionMode=${msg.permissionMode})`);
        } else if (msg.subtype === "compact_boundary") {
          log(phase, `--- context compacted (trigger=${msg.compact_metadata.trigger}, pre_tokens=${msg.compact_metadata.pre_tokens})`);
        }
        break;

      case "assistant": {
        // Try to extract text blocks from the Anthropic message payload.
        const content = (msg.message as any).content ?? [];
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") {
            log(phase, `assistant: ${block.text}`);
          } else if (block?.type === "tool_use") {
            // Log tool name and a brief summary of input
            const inputSummary = this.summarizeToolInput(block.name, block.input);
            log(phase, `tool: ${block.name}${inputSummary ? ` (${inputSummary})` : ""}`);
          }
        }
        break;
      }

      case "result":
        if (msg.subtype === "success") {
          log(phase, `✓ result: turns=${msg.num_turns}, duration=${msg.duration_ms}ms, cost=$${msg.total_cost_usd.toFixed(4)}`);
        } else {
          console.warn(
            `[${ts()}] [${phase}] ✗ result (${msg.subtype}): turns=${msg.num_turns}, errors=${msg.errors?.join("; ")}`
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
