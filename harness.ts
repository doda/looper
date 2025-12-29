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
import { logDebug, logError, logInfo, logWarn } from "./logger.js";
import { pathExists, summarizeValue, truncateText } from "./utils.js";

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** Max consecutive session failures before stopping. */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Default max review iterations in ping-pong flow. */
const DEFAULT_MAX_REVIEW_ITERATIONS = 3;

/** Default max turns for review agent sessions. */
const DEFAULT_MAX_REVIEW_TURNS = 100;

/** Default max turns for audit sessions. */
const DEFAULT_MAX_AUDIT_TURNS = 60;

/** Delay before retrying after a session failure. */
const RETRY_DELAY_MS = 10_000;

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
   * Primary agent for planning and working sessions.
   * - "claude": Use Claude Agent SDK (default)
   * - "codex": Use OpenAI Codex CLI
   */
  primaryAgent?: "claude" | "codex";

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

  /**
   * Base branch used when merging task branches (default: branch).
   */
  baseBranch?: string;

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
   * Enable continuous mode: run an audit when all tasks are passing.
   * The audit can add tasks, then the harness continues.
   */
  continuous?: boolean;

  /**
   * Max number of audit areas (reviewers) for Codex CLI.
   * The model decides the actual number up to this cap.
   */
  specAuditMaxAreas?: number;

  /**
   * Optional Codex model override for audit.
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
  lens?: string;
  paths?: string[];
  rationale?: string;
}

interface SpecAuditPlan {
  areas: SpecAuditPlanArea[];
  notes?: string[];
}

interface SpecAuditIssue {
  category?:
    | "missing"
    | "incorrect"
    | "edge-case"
    | "untested"
    | "security"
    | "bug"
    | "refactor"
    | "performance"
    | "reliability"
    | "observability"
    | "docs"
    | "ux";
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

interface SpecAuditSynthesis {
  result: "PASS" | "FAIL";
  new_tasks?: TaskSpec[];
  summary?: string[];
}

interface SessionResult {
  sessionId: string | null;
  success: boolean;
  errors?: string[];
  errorSubtype?: string;
}

interface AutoCommitContext {
  taskId?: string;
  result?: "PASS" | "FAIL" | "ERROR";
  reason?: string;
}

interface ReviewResult {
  sessionId: string | null;
  passed: boolean;
  issues: string[];
  issuesPath?: string | null;
}

interface CodexAgentResultPayload {
  result?: string;
  notes?: string[];
  tests?: string[];
}

interface CodexAgentResult {
  passed: boolean;
  payload: CodexAgentResultPayload;
  exitCode: number;
  output: string;
}

type CodexLogMode = "summary" | "full" | "quiet";

/**
 * LongRunningHarness implements a two-agent harness on top of the Claude Agent SDK:
 *
 *  - Planning agent: first session only. Analyzes the project spec and creates:
 *      * task_list.json — COMPREHENSIVE list of ALL tasks from the spec with `passes` flags
 *      * agent-progress.txt — log of requirements analysis + onboarding notes
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
  private readonly baseBranch: string;
  private readonly repositoryUrl: string;
  private readonly gitToken?: string;
  private readonly stopFilePath: string;
  private lastReviewIssuesPath: string | null = null;

  constructor(cfg: LongRunningHarnessConfig) {
    this.cfg = cfg;
    if (!cfg.repositoryUrl) {
      throw new Error("repositoryUrl is required for LongRunningHarness");
    }
    if (cfg.primaryAgent === "codex" && cfg.reviewAgent === "claude") {
      throw new Error("primaryAgent=codex cannot use reviewAgent=claude");
    }
    this.workingDir = cfg.workingDir ?? process.cwd();
    this.branch = cfg.branch ?? "main";
    this.baseBranch = cfg.baseBranch ?? this.branch;
    this.repositoryUrl = cfg.repositoryUrl;
    this.gitToken = cfg.gitToken ?? process.env.GITHUB_TOKEN;
    this.stopFilePath =
      cfg.stopFilePath ??
      process.env.LOOPER_STOP_FILE ??
      path.join(this.workingDir, ".looper-stop-after-session");

    this.paths = {
      taskList: path.join(this.workingDir, "task_list.json"),
      progressLog: path.join(this.workingDir, "agent-progress.txt"),
      initScript: path.join(this.workingDir, "init.sh"),
      gitDir: path.join(this.workingDir, ".git"),
    };
  }

  private getPrimaryAgent(): "claude" | "codex" {
    return this.cfg.primaryAgent ?? "claude";
  }

  private getReviewAgent(): "claude" | "codex" {
    return this.cfg.reviewAgent ?? "codex";
  }

  private isCodexPrimary(): boolean {
    return this.getPrimaryAgent() === "codex";
  }

  private getCodexLogMode(): CodexLogMode {
    const raw = process.env.LOOPER_CODEX_LOG_MODE?.toLowerCase();
    if (raw === "full" || raw === "summary" || raw === "quiet") {
      return raw;
    }
    return "summary";
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
        logInfo("Harness", "Project already initialized.");
        return;
      }
    }

    logInfo("Harness", "Project not fully initialized; running planning agent…");
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
    logInfo("Harness", "═══════════════════════════════════════════════════════════");
    logInfo("Harness", "Starting working session");
    logInfo("Harness", "═══════════════════════════════════════════════════════════");

    await this.ensureInitialized();

    const remaining = await this.countRemainingTasks();
    if (remaining != null) {
      logInfo("Harness", `Remaining failing tasks: ${remaining}`);
    }

    const nextTask = await this.getNextFailingTask();
    if (nextTask) {
      logInfo("Harness", `Next task to work on: ${nextTask.id} (${nextTask.category})`);
      logInfo("Harness", `  Description: ${nextTask.description}`);
    }
    const isProjectSetup = nextTask?.id === "project-setup";
    if (isProjectSetup) {
      logInfo("Harness", "This is project-setup (scaffolding phase)");
    }

    if (this.isCodexPrimary()) {
      if (this.cfg.enableReviewAgent && nextTask) {
        return this.runCodexWorkingSessionWithReview(nextTask, isProjectSetup);
      }
      return this.runCodexWorkingSession(isProjectSetup, nextTask ?? undefined);
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
      return this.runWorkingSessionWithReview(nextTask, isProjectSetup, options);
    }

    // Original flow without review agent
    logInfo("Harness", "Starting working agent session…");
    const basePrompt = this.buildWorkingPrompt(isProjectSetup, nextTask ?? undefined);
    try {
      await this.runQuery(basePrompt, options, "working");
      logInfo("Harness", "Working session complete, checking for commits to push...");
      await this.pushIfNeeded("working", {
        taskId: nextTask?.id,
        result: "PASS",
      });
      logInfo("Harness", "═══════════════════════════════════════════════════════════");
      return true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (this.isPromptTooLongText(errMsg)) {
        logInfo("Harness", "Working prompt too long; retrying with compact prompt...");
        const compactPrompt = this.buildCompactWorkingPrompt(isProjectSetup, nextTask ?? undefined);
        try {
          await this.runQuery(compactPrompt, options, "working");
          logInfo("Harness", "Working session complete, checking for commits to push...");
          await this.pushIfNeeded("working", {
            taskId: nextTask?.id,
            result: "PASS",
          });
          logInfo("Harness", "═══════════════════════════════════════════════════════════");
          return true;
        } catch (retryErr) {
          err = retryErr;
        }
      }

      logError("Harness", "═══════════════════════════════════════════════════════════");
      logError("Harness", "Working session failed with error", err);
      logError("Harness", "═══════════════════════════════════════════════════════════");

      // Still try to push any commits that were made before the failure
      try {
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.pushIfNeeded("working", {
          taskId: nextTask?.id,
          result: "ERROR",
          reason: `Working session error: ${errMsg}`,
        });
      } catch (pushErr) {
        logWarn("Harness", "Failed to push after error", pushErr);
      }

      return false;
    }
  }

  /**
   * Run a single working session for a specific task.
   */
  async runSingleTask(taskId: string): Promise<boolean> {
    logInfo("Harness", `Starting single-task session for: ${taskId}`);

    await this.ensureInitialized();

    const taskList = await this.readTaskList();
    const task = taskList.find((item) => item.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found in task_list.json`);
    }

    const isProjectSetup = task.id === "project-setup";
    if (this.isCodexPrimary()) {
      if (this.cfg.enableReviewAgent) {
        return this.runCodexWorkingSessionWithReview(task, isProjectSetup);
      }
      return this.runCodexWorkingSession(isProjectSetup, task);
    }

    const options: Options = {
      ...this.buildBaseOptions("working"),
      maxTurns: this.cfg.maxWorkingTurns,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...this.cfg.sdkOptionsOverride,
    };

    if (this.cfg.enableReviewAgent) {
      return this.runWorkingSessionWithReview(task, isProjectSetup, options);
    }

    const prompt = this.buildWorkingPrompt(isProjectSetup, task);

    try {
      await this.runQuery(prompt, options, "working");
      logInfo("Harness", "Single-task session complete, checking for commits to push...");
      await this.pushIfNeeded("working", {
        taskId: task.id,
        result: "PASS",
      });
      logInfo("Harness", "═══════════════════════════════════════════════════════════");
      return true;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (this.isPromptTooLongText(errMsg)) {
        logInfo("Harness", "Working prompt too long; retrying with compact prompt...");
        const compactPrompt = this.buildCompactWorkingPrompt(isProjectSetup, task);
        try {
          await this.runQuery(compactPrompt, options, "working");
          logInfo("Harness", "Single-task session complete, checking for commits to push...");
          await this.pushIfNeeded("working", {
            taskId: task.id,
            result: "PASS",
          });
          logInfo("Harness", "═══════════════════════════════════════════════════════════");
          return true;
        } catch (retryErr) {
          err = retryErr;
        }
      }

      logError("Harness", "═══════════════════════════════════════════════════════════");
      logError("Harness", "Single-task session failed with error", err);
      logError("Harness", "═══════════════════════════════════════════════════════════");

      try {
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.pushIfNeeded("working", {
          taskId: task.id,
          result: "ERROR",
          reason: `Single-task session error: ${errMsg}`,
        });
      } catch (pushErr) {
        logWarn("Harness", "Failed to push after error", pushErr);
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
    options: Options
  ): Promise<boolean> {
    const maxIterations = this.cfg.maxReviewIterations ?? DEFAULT_MAX_REVIEW_ITERATIONS;

    let workingSessionId: string | null = null;
    let reviewSessionId: string | null = null;

    logInfo("Harness", "═══════════════════════════════════════════════════════════");
    logInfo("Harness", "Review agent enabled - using ping-pong flow");
    logInfo("Harness", "═══════════════════════════════════════════════════════════");

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      logInfo("Harness", `─── Iteration ${iteration}/${maxIterations} ───`);

      try {
        // Phase 1: Working agent implements or fixes
        if (workingSessionId === null) {
          // First iteration: fresh implementation
          logInfo("Harness", "Starting working agent (implementation phase)…");
          const workingPrompt = this.buildWorkingPromptForReview(isProjectSetup, task);
          const result = await this.runQueryWithSessionCapture(workingPrompt, options, "working");
          workingSessionId = result.sessionId;

          if (!result.success) {
            if (this.isPromptTooLong(result)) {
              logInfo("Harness", "Working prompt too long; retrying with compact prompt...");
              const compactPrompt = this.buildCompactWorkingPromptForReview(isProjectSetup, task);
              const compactResult = await this.runQueryWithSessionCapture(compactPrompt, options, "working");
              workingSessionId = compactResult.sessionId;

              if (!compactResult.success) {
                logError("Harness", "Working agent failed during implementation (compact prompt)");
                // DO NOT push - revert to clean state
                await this.syncRepoFromRemote();
                return false;
              }
            } else {
              logError("Harness", "Working agent failed during implementation");
              // DO NOT push - revert to clean state
              await this.syncRepoFromRemote();
              return false;
            }
          }
        } else {
          // Subsequent iterations: resume with fix instructions
          logInfo("Harness", "Resuming working agent (fixing phase)…");
          const lastIssues = this.lastReviewIssues ?? [];
          const fixPrompt = this.buildFixPrompt(lastIssues, this.lastReviewIssuesPath);
          const result = await this.resumeSession(workingSessionId, fixPrompt, options, "fixing");

          if (!result.success) {
            if (this.isPromptTooLong(result)) {
              logInfo("Harness", "Working agent resume failed due to prompt length; starting a fresh fix session...");
              const freshPrompt = this.buildFixPrompt(lastIssues, this.lastReviewIssuesPath);
              const freshResult = await this.runQueryWithSessionCapture(freshPrompt, options, "fixing");
              workingSessionId = freshResult.sessionId;

              if (!freshResult.success) {
                logError("Harness", "Working agent failed during fixing (fresh session)");
                // DO NOT push - revert to clean state
                await this.syncRepoFromRemote();
                return false;
              }
            } else {
              logError("Harness", "Working agent failed during fixing");
              // DO NOT push - revert to clean state
              await this.syncRepoFromRemote();
              return false;
            }
          }
        }

        // DO NOT push yet - wait for review approval
        // Changes remain local (staged/unstaged) until review passes

        // Check if task already passing and committed - skip review
        const taskList = await this.readTaskList();
        const currentTask = taskList.find((t) => t.id === task.id);
        if (currentTask?.passes === true) {
          logInfo("Harness", `Task ${task.id} already marked passing - pushing`);
          await this.pushIfNeeded("working", {
            taskId: task.id,
            result: "PASS",
          });
          return true;
        }

        // Phase 2: Review agent audits (default: codex)
        const useCodex = this.cfg.reviewAgent !== "claude";
        logInfo("Harness", `Starting review agent (${useCodex ? "codex" : "claude"})…`);
        let reviewResult: ReviewResult;
        if (useCodex) {
          reviewResult = await this.runCodexReview(task, iteration > 1);
        } else {
          reviewResult = await this.runReviewAgent(task, options, reviewSessionId);
          reviewSessionId = reviewResult.sessionId;
        }

        if (reviewResult.passed) {
          this.lastReviewIssuesPath = null;
          // Verify the reviewer actually updated task_list.json
          const taskList = await this.readTaskList();
          const updatedTask = taskList.find((t) => t.id === task.id);
          if (!updatedTask?.passes) {
            logWarn("Harness", `Review said PASS but task ${task.id} not marked as passing in task_list.json`);
            logWarn("Harness", "Treating as failed review - reviewer must update task_list.json");
            this.lastReviewIssues = ["Reviewer approved but did not update task_list.json"];
            continue; // Go to next iteration
          }

          logInfo("Harness", "═══════════════════════════════════════════════════════════");
          logInfo("Harness", `✓ Review agent APPROVED task: ${task.id}`);
          logInfo("Harness", "═══════════════════════════════════════════════════════════");
          // Only push after review approval (and task marked passing)
          await this.pushIfNeeded("review");
          return true;
        }

        // Store issues for next fix iteration
        this.lastReviewIssues = reviewResult.issues;
        this.lastReviewIssuesPath = reviewResult.issuesPath ?? this.lastReviewIssuesPath;
        logInfo("Harness", `Review agent found ${reviewResult.issues.length} issue(s):`);
        for (const issue of reviewResult.issues) {
          logInfo("Harness", `  - ${issue}`);
        }

        if (iteration === maxIterations) {
          logError("Harness", "═══════════════════════════════════════════════════════════");
          logError("Harness", `✗ Task ${task.id} failed review after ${maxIterations} iterations`);
          logError("Harness", "═══════════════════════════════════════════════════════════");
          // DO NOT push - review failed, don't commit bad code
          // Revert local changes so next session starts clean
          await this.syncRepoFromRemote();
          return false;
        }

        logInfo("Harness", "Sending issues to working agent for fixes...");

      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);

        // OAuth token expiration - throw immediately to stop the harness
        if (errMsg.toLowerCase().includes("oauth") || errMsg.includes("token revoked") || errMsg.includes("/login")) {
          throw new Error(`Authentication expired: ${errMsg}`);
        }

        const isPromptTooLong = this.isPromptTooLongText(errMsg);

        if (isPromptTooLong && workingSessionId !== null && this.lastReviewIssues.length > 0) {
          // Prompt too long during resume - start fresh fix session
          logInfo("Harness", "Session context too long, starting fresh fix session...");
          try {
            const freshPrompt = this.buildFixPrompt(this.lastReviewIssues, this.lastReviewIssuesPath);
            const freshResult = await this.runQueryWithSessionCapture(freshPrompt, options, "fixing");
            workingSessionId = freshResult.sessionId;

            if (freshResult.success) {
              // Fresh session worked, continue to review
              continue;
            }
          } catch (freshErr) {
            logInfo("Harness", `Fresh fix session also failed: ${freshErr instanceof Error ? freshErr.message : freshErr}`);
          }
        }

        logError("Harness", "═══════════════════════════════════════════════════════════");
        logError("Harness", `Error during iteration ${iteration}: ${errMsg}`);
        logError("Harness", "═══════════════════════════════════════════════════════════");

        // DO NOT push on error - revert to clean state
        try {
          await this.syncRepoFromRemote();
        } catch (syncErr) {
          logWarn("Harness", "Failed to sync after error", syncErr);
        }

        return false;
      }
    }

    return false;
  }

  private async runCodexWorkingSession(
    isProjectSetup: boolean,
    task?: TaskSpec
  ): Promise<boolean> {
    logInfo("Harness", "Starting Codex working agent session…");
    const nonce = randomUUID();
    const prompt = this.buildCodexWorkingPrompt(isProjectSetup, task, nonce);

    try {
      const result = await this.runCodexAgentPrompt(
        prompt,
        "working",
        "CODEX_WORKING_RESULT",
        nonce
      );
      logInfo("Harness", "Working session complete, checking for commits to push...");
      const reason = result.passed
        ? undefined
        : result.exitCode !== 0
          ? `Codex working session exitCode=${result.exitCode}.`
          : "Codex working session reported FAIL.";
      await this.pushIfNeeded("working", {
        taskId: task?.id,
        result: result.passed ? "PASS" : "FAIL",
        reason,
      });
      return result.passed;
    } catch (err) {
      logError("Harness", "Codex working session failed", err);
      try {
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.pushIfNeeded("working", {
          taskId: task?.id,
          result: "ERROR",
          reason: `Codex working session error: ${errMsg}`,
        });
      } catch (pushErr) {
        logWarn("Harness", "Failed to push after error", pushErr);
      }
      return false;
    }
  }

  private async runCodexWorkingSessionWithReview(
    task: TaskSpec,
    isProjectSetup: boolean
  ): Promise<boolean> {
    const reviewAgent = this.getReviewAgent();
    if (reviewAgent === "claude") {
      throw new Error("Codex primary mode requires codex review agent");
    }

    const maxIterations = this.cfg.maxReviewIterations ?? DEFAULT_MAX_REVIEW_ITERATIONS;

    logInfo("Harness", "═══════════════════════════════════════════════════════════");
    logInfo("Harness", "Review agent enabled - using Codex ping-pong flow");
    logInfo("Harness", "═══════════════════════════════════════════════════════════");

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      logInfo("Harness", `─── Iteration ${iteration}/${maxIterations} ───`);

      try {
        const nonce = randomUUID();
        const prompt = iteration === 1
          ? this.buildCodexWorkingPromptForReview(isProjectSetup, task, nonce)
          : this.buildCodexFixPrompt(this.lastReviewIssues, this.lastReviewIssuesPath, nonce);

        const phase: HarnessPhase = iteration === 1 ? "working" : "fixing";
        const result = await this.runCodexAgentPrompt(
          prompt,
          phase,
          "CODEX_WORKING_RESULT",
          nonce
        );

        if (!result.passed) {
          logError("Harness", "Codex working agent reported failure");
          await this.syncRepoFromRemote();
          return false;
        }

        const taskList = await this.readTaskList();
        const currentTask = taskList.find((t) => t.id === task.id);
        if (currentTask?.passes === true) {
          logInfo("Harness", `Task ${task.id} already marked passing - pushing`);
          await this.pushIfNeeded("working", {
            taskId: task.id,
            result: "PASS",
          });
          return true;
        }

        const reviewResult = await this.runCodexReview(task, iteration > 1);
        if (reviewResult.passed) {
          this.lastReviewIssuesPath = null;
          const updatedTaskList = await this.readTaskList();
          const updatedTask = updatedTaskList.find((t) => t.id === task.id);
          if (!updatedTask?.passes) {
            logWarn("Harness", `Review said PASS but task ${task.id} not marked as passing in task_list.json`);
            logWarn("Harness", "Treating as failed review - reviewer must update task_list.json");
            this.lastReviewIssues = ["Reviewer approved but did not update task_list.json"];
            continue;
          }

          logInfo("Harness", "═══════════════════════════════════════════════════════════");
          logInfo("Harness", `✓ Review agent APPROVED task: ${task.id}`);
          logInfo("Harness", "═══════════════════════════════════════════════════════════");
          await this.pushIfNeeded("review");
          return true;
        }

        this.lastReviewIssues = reviewResult.issues;
        this.lastReviewIssuesPath = reviewResult.issuesPath ?? this.lastReviewIssuesPath;
        logInfo("Harness", `Review agent found ${reviewResult.issues.length} issue(s):`);
        for (const issue of reviewResult.issues) {
          logInfo("Harness", `  - ${issue}`);
        }

        if (iteration === maxIterations) {
          logError("Harness", "═══════════════════════════════════════════════════════════");
          logError("Harness", `✗ Task ${task.id} failed review after ${maxIterations} iterations`);
          logError("Harness", "═══════════════════════════════════════════════════════════");
          await this.syncRepoFromRemote();
          return false;
        }

        logInfo("Harness", "Sending issues to working agent for fixes...");
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logError("Harness", "═══════════════════════════════════════════════════════════");
        logError("Harness", `Error during iteration ${iteration}: ${errMsg}`);
        logError("Harness", "═══════════════════════════════════════════════════════════");

        try {
          await this.syncRepoFromRemote();
        } catch (syncErr) {
          logWarn("Harness", "Failed to sync after error", syncErr);
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

    const maxConsecutiveFailures = MAX_CONSECUTIVE_FAILURES;
    let consecutiveFailures = 0;
    let successfulSessions = 0;

    for (let i = 0; i < sessionLimit; i++) {
      const remaining = await this.countRemainingTasks();
      if (remaining === 0) {
        if (!this.cfg.continuous) {
          logInfo("Harness", "All tasks are marked as passing. Nothing left to do.");
          return;
        }

        logInfo("Harness", "All tasks passing; starting audit...");
        const auditResult = await this.runSpecAudit();
        if (auditResult.addedTasks === 0) {
          logInfo("Harness", "Audit passed with no new tasks.");
          return;
        }
        logInfo(
          "Harness",
          `Audit added ${auditResult.addedTasks} task(s); continuing.`
        );
        continue;
      }

      const limitStr = maxSessions > 0 ? `of ${maxSessions}` : "(unlimited)";
      logInfo(
        "Harness",
        `===== Working session #${i + 1} ${limitStr} | ${remaining ?? "?"} tasks remaining =====`
      );

      const success = await this.runWorkingSession();

      if (success) {
        consecutiveFailures = 0;
        successfulSessions++;
      } else {
        consecutiveFailures++;
        logWarn(
          "Harness",
          `Session failed. Consecutive failures: ${consecutiveFailures}/${maxConsecutiveFailures}`
        );

        if (consecutiveFailures >= maxConsecutiveFailures) {
          logError(
            "Harness",
            `Too many consecutive failures (${consecutiveFailures}). Stopping to prevent infinite loop.`
          );
          logError(
            "Harness",
            `Completed ${successfulSessions} successful sessions before failure.`
          );
          throw new Error(
            `Harness stopped after ${consecutiveFailures} consecutive session failures`
          );
        }

        // Brief delay before retrying to avoid hammering the API
        logInfo("Harness", "Waiting 10 seconds before retrying...");
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }

      if (await this.shouldStopAfterSession()) {
        logInfo("Harness", "Stop requested; exiting after completing this session.");
        return;
      }
    }

    if (sessionLimit !== Number.MAX_SAFE_INTEGER) {
      logInfo("Harness", "Reached maxSessions limit.");
    } else {
      logInfo("Harness", "Stopping unlimited run loop.");
    }
  }

  /**
   * Run an audit when all tasks are passing.
   * Uses the configured review agent where possible, with fallback on failure.
   */
  async runSpecAudit(): Promise<{ addedTasks: number }> {
    const auditLens = await this.getNextSpecAuditLens();
    logInfo("audit", `Audit lens: ${auditLens}`);
    const reviewAgent = this.getReviewAgent();
    if (this.isCodexPrimary()) {
      if (!(await this.hasCodexCredentials())) {
        logInfo("audit", "Codex credentials not available; skipping audit in codex-only mode.");
        return { addedTasks: 0 };
      }
      try {
        return await this.runCodexSpecAudit(auditLens);
      } catch (err) {
        logInfo(
          "audit",
          `Codex audit failed (codex-only): ${err instanceof Error ? err.message : String(err)}`
        );
        return { addedTasks: 0 };
      }
    }

    if (reviewAgent === "claude") {
      return this.runClaudeSpecAudit(auditLens);
    }

    if (!(await this.hasCodexCredentials())) {
      logInfo("audit", "Codex credentials not available; falling back to Claude audit.");
      return this.runClaudeSpecAudit(auditLens);
    }

    try {
      return await this.runCodexSpecAudit(auditLens);
    } catch (err) {
      logInfo(
        "audit",
        `Codex audit failed: ${err instanceof Error ? err.message : String(err)}`
      );
      try {
        return await this.runClaudeSpecAudit(auditLens);
      } catch (fallbackErr) {
        logInfo(
          "audit",
          `Claude audit fallback failed: ${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`
        );
        return { addedTasks: 0 };
      }
    }
  }

  /**
   * Run a Codex-driven audit when all tasks are passing.
   * Returns counts of new tasks.
   */
  private async runCodexSpecAudit(auditLens: string): Promise<{ addedTasks: number }> {
    const maxAreas = Math.max(1, this.cfg.specAuditMaxAreas ?? 10);
    const repoSummary = await this.buildRepoSummary();

    const plan = await this.runCodexSpecAuditPlan(maxAreas, repoSummary, auditLens);
    const areas = this.sanitizeSpecAuditAreas(plan.areas, maxAreas, auditLens);
    this.logSpecAuditPlan(plan, areas);

    const areaResults = await this.runSpecAuditAreas(areas, repoSummary);
    this.logSpecAuditAreaResults(areaResults);
    const taskListRaw = await fs.readFile(this.paths.taskList, "utf8");
    const synthesis = await this.runCodexSpecAuditSynthesis(
      plan,
      areas,
      areaResults,
      taskListRaw,
      repoSummary
    );
    this.logSpecAuditSynthesis(synthesis);

    const { addedTasks } = await this.applySpecAuditResults(
      synthesis,
      areas.length,
      auditLens
    );

    await this.pushIfNeeded("audit");

    return { addedTasks };
  }

  private async runClaudeSpecAudit(auditLens: string): Promise<{ addedTasks: number }> {
    const before = await this.readTaskList();
    const options: Options = {
      ...this.buildBaseOptions("audit"),
      maxTurns: this.cfg.maxReviewTurns ?? DEFAULT_MAX_AUDIT_TURNS,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      ...this.cfg.sdkOptionsOverride,
    };

    await this.runQuery(this.buildSpecAuditClaudePrompt(auditLens), options, "audit");

    const after = await this.readTaskList();
    const { addedTasks } = this.countTaskChanges(before, after);

    await this.pushIfNeeded("audit");
    return { addedTasks };
  }

  private countTaskChanges(
    before: TaskList,
    after: TaskList
  ): { addedTasks: number } {
    const beforeById = new Map(before.map((task) => [task.id, task]));
    let addedTasks = 0;

    for (const task of after) {
      const prev = beforeById.get(task.id);
      if (!prev) {
        addedTasks += 1;
        continue;
      }
    }

    return { addedTasks };
  }

  private async hasCodexCredentials(): Promise<boolean> {
    if (process.env.CODEX_CREDENTIALS_JSON) return true;
    const home = process.env.HOME ?? "/home/looper";
    const authPath = path.join(home, ".codex", "auth.json");
    return pathExists(authPath);
  }

  private async runSpecAuditAreas(
    areas: SpecAuditPlanArea[],
    repoSummary: string
  ): Promise<SpecAuditAreaResult[]> {
    if (areas.length === 0) {
      return [];
    }

    // Run all areas in parallel
    const results = await Promise.all(
      areas.map((area) => this.runCodexSpecAuditArea(area, repoSummary))
    );
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

  private getSpecAuditLenses(): string[] {
    return ["integration-testing", "correctness", "safety", "maintainability"];
  }

  private async getNextSpecAuditLens(): Promise<string> {
    const lenses = this.getSpecAuditLenses();
    if (!(await pathExists(this.paths.progressLog))) {
      return lenses[0];
    }
    try {
      const contents = await fs.readFile(this.paths.progressLog, "utf8");
      const pattern = /(?:Spec audit|Audit)[^\n]*\blens=([a-z-]+)/g;
      let match: RegExpExecArray | null = null;
      let lastLens: string | undefined;
      while ((match = pattern.exec(contents)) !== null) {
        lastLens = match[1];
      }
      if (!lastLens) {
        return lenses[0];
      }
      const lastIndex = lenses.indexOf(lastLens);
      if (lastIndex === -1) {
        return lenses[0];
      }
      return lenses[(lastIndex + 1) % lenses.length];
    } catch {
      return lenses[0];
    }
  }

  private sanitizeSpecAuditAreas(
    areas: SpecAuditPlanArea[] | undefined,
    maxAreas: number,
    auditLens: string
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
        lens: auditLens,
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
        lens: auditLens,
        paths: [],
      });
    }

    return normalized;
  }

  private async runCodexSpecAuditPlan(
    maxAreas: number,
    repoSummary: string,
    auditLens: string
  ): Promise<SpecAuditPlan> {
    const nonce = randomUUID();
    const prompt = this.buildSpecAuditPlanPrompt(maxAreas, repoSummary, nonce, auditLens);
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
    areaCount: number,
    auditLens: string
  ): Promise<{ addedTasks: number }> {
    const taskList = await this.readTaskList();
    const keyOrder = taskList.length > 0 ? Object.keys(taskList[0]) : undefined;
    const existingIds = new Set(taskList.map((task) => task.id));
    let addedTasks = 0;

    const newTasks = Array.isArray(synthesis.new_tasks) ? synthesis.new_tasks : [];
    for (const rawTask of newTasks) {
      const normalized = this.normalizeNewTask(rawTask, keyOrder, false);
      if (!normalized) continue;
      let id = normalized.id;
      if (existingIds.has(id)) {
        let suffix = 2;
        while (existingIds.has(`${id}-${suffix}`)) suffix += 1;
        id = `${id}-${suffix}`;
      }
      normalized.id = id;
      taskList.push(normalized);
      existingIds.add(id);
      addedTasks += 1;
    }

    const summaryBits = [
      synthesis.result ? synthesis.result.toUpperCase() : "UNKNOWN",
      `${areaCount} area(s)`,
      `${addedTasks} new`,
      `lens=${auditLens}`,
    ];
    const progressEntry = `[${new Date().toISOString()}] Audit (codex): ${summaryBits.join(", ")}.\n`;

    await fs.writeFile(this.paths.taskList, JSON.stringify(taskList, null, 2) + "\n");
    await fs.appendFile(this.paths.progressLog, progressEntry, "utf8");

    const env = this.buildGitEnv();
    await this.ensureGitIdentity(env);
    await execFileAsync("git", ["-C", this.workingDir, "add", "task_list.json", "agent-progress.txt"], { env });

    const status = await execFileAsync("git", ["-C", this.workingDir, "status", "--porcelain"], { env });
    if (status.stdout.trim()) {
      const message = `Audit: ${addedTasks} new`;
      await execFileAsync("git", ["-C", this.workingDir, "commit", "-m", message], { env });
    }

    return { addedTasks };
  }

  private normalizeNewTask(
    raw: TaskSpec | undefined,
    _keyOrder?: string[],
    passesOverride?: boolean
  ): TaskSpec | null {
    if (!raw || typeof raw !== "object") return null;
    const id = typeof raw.id === "string" ? this.normalizeTaskId(raw.id) : "";
    const description = typeof raw.description === "string" ? raw.description.trim() : "";
    const category = typeof raw.category === "string" ? raw.category.trim() : "audit";
    const steps = Array.isArray(raw.steps)
      ? raw.steps.filter((step): step is string => typeof step === "string" && step.trim().length > 0)
      : [];
    if (!id || !description || steps.length === 0) return null;

    const depends_on = Array.isArray(raw.depends_on)
      ? raw.depends_on.filter((dep): dep is string => typeof dep === "string" && dep.trim().length > 0)
      : undefined;
    const scope = Array.isArray(raw.scope)
      ? raw.scope.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      : undefined;

    // Build the normalized task with proper types
    const task: TaskSpec = {
      id,
      category,
      description,
      steps,
      ...(depends_on && depends_on.length > 0 ? { depends_on } : {}),
      ...(scope && scope.length > 0 ? { scope } : {}),
      ...(typeof passesOverride === "boolean" ? { passes: passesOverride } : {}),
    };

    return task;
  }

  private normalizeTaskId(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/-+/g, "-");
  }

  private logSpecAuditPlan(plan: SpecAuditPlan, areas: SpecAuditPlanArea[]): void {
    logInfo("audit", `Audit plan: ${areas.length} area(s).`);
    for (const area of areas) {
      const focus = summarizeValue(area.focus, 180);
      const title = summarizeValue(area.title, 120);
      const lens = summarizeValue(area.lens, 80);
      const paths = Array.isArray(area.paths) && area.paths.length > 0
        ? ` paths=${area.paths.join(", ")}`
        : "";
      const lensSuffix = lens ? ` lens="${lens}"` : "";
      logInfo("audit", `Audit area: ${area.id} "${title}"${lensSuffix} focus="${focus}"${paths}`);
    }
    if (plan.notes && plan.notes.length > 0) {
      for (const note of plan.notes) {
        logInfo("audit", `Audit plan note: ${summarizeValue(note, 240)}`);
      }
    }
  }

  private logSpecAuditAreaResults(areaResults: SpecAuditAreaResult[]): void {
    for (const result of areaResults) {
      const summary = summarizeValue(result.summary, 240);
      logInfo("audit", `Audit result: ${result.area_id} ${result.status}${summary ? ` - ${summary}` : ""}`);
      const issues = Array.isArray(result.issues) ? result.issues : [];
      for (const issue of issues) {
        const category = issue.category ? issue.category : "issue";
        const severity = issue.severity ? issue.severity : "unspecified";
        const detail = summarizeValue(issue.issue, 260);
        const evidence = summarizeValue(issue.evidence, 200);
        const specRef = summarizeValue(issue.spec_ref, 200);
        const suffixParts = [];
        if (evidence) suffixParts.push(`evidence=${evidence}`);
        if (specRef) suffixParts.push(`spec=${specRef}`);
        const suffix = suffixParts.length > 0 ? ` (${suffixParts.join("; ")})` : "";
        logInfo("audit", `Audit issue: [${severity}/${category}] ${detail}${suffix}`);
      }
      const notes = Array.isArray(result.notes) ? result.notes : [];
      for (const note of notes) {
        logInfo("audit", `Audit note: ${summarizeValue(note, 240)}`);
      }
    }
  }

  private logSpecAuditSynthesis(synthesis: SpecAuditSynthesis): void {
    const newTasks = Array.isArray(synthesis.new_tasks) ? synthesis.new_tasks : [];
    logInfo(
      "audit",
      `Audit synthesis: result=${synthesis.result}, new_tasks=${newTasks.length}`
    );
    for (const task of newTasks) {
      const description = summarizeValue(task.description, 260);
      logInfo("audit", `Audit new task: ${task.id} ${description ? `- ${description}` : ""}`);
    }
    if (synthesis.summary && synthesis.summary.length > 0) {
      for (const note of synthesis.summary) {
        logInfo("audit", `Audit summary: ${summarizeValue(note, 240)}`);
      }
    }
  }

  private extractCodexJson(output: string, marker: string, nonce?: string): string {
    const pattern = nonce
      ? new RegExp(
        `<<<${marker}:${nonce}>>>\\s*([\\s\\S]*?)\\s*<<<END_${marker}:${nonce}>>>`,
        "g"
      )
      : new RegExp(
        `<<<${marker}:([a-zA-Z0-9-]+)>>>\\s*([\\s\\S]*?)\\s*<<<END_${marker}:\\1>>>`,
        "g"
      );
    const matches = [...output.matchAll(pattern)];
    if (matches.length === 0) {
      throw new Error(`Failed to parse Codex output for ${marker}`);
    }
    const last = matches[matches.length - 1];
    const payload = nonce ? last?.[1] : last?.[2];
    return (payload ?? "").trim();
  }

  private normalizeCodexResult(value: string | undefined): "PASS" | "FAIL" {
    const normalized = (value ?? "").trim().toUpperCase();
    if (normalized === "PASS" || normalized === "FAIL") {
      return normalized;
    }
    throw new Error(`Invalid Codex result value: ${value ?? "(missing)"}`);
  }

  private parseCodexAgentResult(
    output: string,
    marker: string,
    nonce: string
  ): CodexAgentResultPayload {
    const json = this.extractCodexJson(output, marker, nonce);
    const payload = JSON.parse(json) as CodexAgentResultPayload;
    if (!payload || typeof payload !== "object") {
      throw new Error(`Codex output for ${marker} is not a JSON object`);
    }
    return payload;
  }

  private async execCodexJson(
    prompt: string,
    label: string,
    model?: string,
    logPrefix?: string,
    logMode?: CodexLogMode,
    suppressMarkers?: string[]
  ): Promise<{
    exitCode: number;
    agentMessages: string[];
    lastAgentMessage: string;
    stderr: string;
  }> {
    logInfo("Harness", `Running Codex CLI (${label})...`);
    const args = ["exec", "--json"];
    if (model) {
      args.push("-m", model);
    }
    args.push("--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "-");

    return new Promise((resolve, reject) => {
      const proc = spawn("codex", args, {
        cwd: this.workingDir,
        env: {
          ...process.env,
          GIT_DIR: path.join(this.workingDir, ".git"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      const mode = logMode ?? this.getCodexLogMode();
      const agentMessages: string[] = [];
      let lastAgentMessage = "";
      let stdoutBuffer = "";
      let stderr = "";
      const streamBuffers = new Map<string, string>();
      const logState = { logged: false };

      const logLine = (line: string): void => {
        if (!logPrefix) return;
        const trimmed = line.trim();
        if (!trimmed) return;
        if (trimmed.startsWith("<<<CODEX_") || trimmed.startsWith("<<<END_CODEX_")) return;
        if (suppressMarkers && suppressMarkers.some((marker) => trimmed.includes(marker))) return;
        logState.logged = true;
        logInfo(logPrefix, `codex: ${trimmed}`);
      };

      const logReasoning = (text: string): void => {
        if (mode === "quiet") return;
        const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
        if (mode === "full") {
          for (const line of lines) {
            logLine(line);
          }
          return;
        }
        let logged = false;
        for (const line of lines) {
          if (line.startsWith("**") || line.startsWith("thinking")) {
            logLine(line);
            logged = true;
          }
        }
        if (!logged && lines[0]) {
          logLine(lines[0].slice(0, 200));
        }
      };

      const formatDuration = (duration: any): string => {
        const secs = typeof duration?.secs === "number" ? duration.secs : 0;
        const nanos = typeof duration?.nanos === "number" ? duration.nanos : 0;
        const ms = secs * 1000 + nanos / 1e6;
        return `${ms.toFixed(0)}ms`;
      };

      const logExecBegin = (cmd: string, cwd?: string): void => {
        if (mode === "quiet") return;
        const cwdNote = cwd ? ` (cwd ${cwd})` : "";
        logLine(`exec ${cmd}${cwdNote}`);
      };

      const logExecEnd = (exitCode: number, duration?: any): void => {
        if (exitCode === 0 && mode !== "full") return;
        const dur = duration ? ` in ${formatDuration(duration)}` : "";
        logLine(`exec exit ${exitCode}${dur}`);
      };

      const logOutputDelta = (stream: string, chunk: number[], callId: string): void => {
        const text = Buffer.from(chunk).toString("utf8");
        const key = `${callId}:${stream}`;
        const buffer = (streamBuffers.get(key) ?? "") + text;
        const lines = buffer.split("\n");
        streamBuffers.set(key, lines.pop() ?? "");

        const shouldLog =
          mode === "full" ||
          (mode === "summary" && stream === "stderr");
        if (!shouldLog) return;
        for (const line of lines) {
          logLine(line);
        }
      };

      const logErrorOutput = (stderrText: string): void => {
        if (!stderrText.trim()) return;
        const lines = stderrText.split("\n").map((line) => line.trim()).filter(Boolean);
        const limited = lines.slice(0, 20);
        for (const line of limited) {
          logLine(line);
        }
        if (lines.length > limited.length) {
          logLine(`(stderr truncated, ${lines.length - limited.length} more lines)`);
        }
      };

      const logTextBlock = (text: string, maxLines: number): void => {
        const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
        const limited = lines.slice(0, maxLines);
        for (const line of limited) {
          logLine(line);
        }
        if (lines.length > limited.length) {
          logLine(`(output truncated, ${lines.length - limited.length} more lines)`);
        }
      };

      const handleMessage = (msg: any): void => {
        switch (msg?.type) {
          case "task_started":
            if (mode !== "quiet") {
              logLine("task started");
            }
            break;
          case "agent_reasoning":
            if (typeof msg.text === "string") {
              logReasoning(msg.text);
            }
            break;
          case "exec_command_begin": {
            const cmd = Array.isArray(msg.command) ? msg.command.join(" ") : String(msg.command ?? "");
            const cwd = typeof msg.cwd === "string" ? msg.cwd : undefined;
            logExecBegin(cmd, cwd);
            break;
          }
          case "exec_command_output_delta": {
            if (Array.isArray(msg.chunk)) {
              logOutputDelta(String(msg.stream ?? "stdout"), msg.chunk, String(msg.call_id ?? "unknown"));
            }
            break;
          }
          case "exec_command_end": {
            const exitCode = typeof msg.exit_code === "number" ? msg.exit_code : 0;
            logExecEnd(exitCode, msg.duration);
            if (exitCode !== 0) {
              const stderrText = typeof msg.stderr === "string" ? msg.stderr : "";
              if (mode !== "full") {
                logErrorOutput(stderrText);
              }
            }
            break;
          }
          case "agent_message": {
            if (typeof msg.message === "string") {
              agentMessages.push(msg.message);
              lastAgentMessage = msg.message;
              if (mode === "full") {
                const stripped = msg.message.replace(/<<<CODEX_[\s\S]*?<<<END_CODEX_[^>]*>>>/g, "").trim();
                if (stripped) {
                  for (const line of stripped.split("\n")) {
                    logLine(line);
                  }
                }
              } else if (mode === "summary") {
                const stripped = msg.message.replace(/<<<CODEX_[\s\S]*?<<<END_CODEX_[^>]*>>>/g, "").trim();
                if (stripped) {
                  const firstLine = stripped.split("\n")[0];
                  if (firstLine) logLine(firstLine.slice(0, 200));
                }
              }
            }
            break;
          }
          default:
            break;
        }
      };

      const handleLegacyEvent = (event: any): void => {
        const eventType = typeof event?.type === "string" ? event.type : "";
        if (!eventType) return;

        if (eventType === "thread.started" || eventType === "turn.started") {
          if (mode !== "quiet") {
            logLine(eventType.replace(".", " "));
          }
          return;
        }

        if (eventType === "error") {
          const message = typeof event?.message === "string" ? event.message : "unknown error";
          logLine(`error ${message}`);
          return;
        }

        if (eventType === "turn.failed") {
          const message = typeof event?.error?.message === "string" ? event.error.message : "turn failed";
          logLine(`turn failed: ${message}`);
          return;
        }

        if (eventType === "turn.completed") {
          if (mode !== "quiet") {
            logLine("turn completed");
          }
          return;
        }

        if (eventType === "item.started" || eventType === "item.completed") {
          const item = event?.item ?? {};
          const itemType = typeof item?.type === "string" ? item.type : "";
          if (itemType === "reasoning" && typeof item?.text === "string") {
            logReasoning(item.text);
            return;
          }
          if (itemType === "agent_message" && typeof item?.text === "string") {
            agentMessages.push(item.text);
            lastAgentMessage = item.text;
            if (mode === "full") {
              const stripped = item.text.replace(/<<<CODEX_[\s\S]*?<<<END_CODEX_[^>]*>>>/g, "").trim();
              if (stripped) {
                logTextBlock(stripped, 200);
              }
            } else if (mode === "summary") {
              const stripped = item.text.replace(/<<<CODEX_[\s\S]*?<<<END_CODEX_[^>]*>>>/g, "").trim();
              if (stripped) {
                const firstLine = stripped.split("\n")[0];
                if (firstLine) logLine(firstLine.slice(0, 200));
              }
            }
            return;
          }
          if (itemType === "command_execution") {
            const command = typeof item?.command === "string" ? item.command : "";
            if (eventType === "item.started") {
              if (command) logExecBegin(command);
              return;
            }
            const exitCode = typeof item?.exit_code === "number" ? item.exit_code : 0;
            logExecEnd(exitCode);
            const output = typeof item?.aggregated_output === "string" ? item.aggregated_output : "";
            if (output) {
              if (mode === "full") {
                logTextBlock(output, 200);
              } else if (exitCode !== 0) {
                logTextBlock(output, 40);
              }
            }
          }
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString();
        const lines = stdoutBuffer.split("\n");
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed?.msg) {
              handleMessage(parsed.msg);
            } else if (parsed?.type) {
              handleLegacyEvent(parsed);
            }
          } catch (err) {
            logWarn("Harness", `Failed to parse Codex JSON line: ${line.slice(0, 200)}`);
          }
        }
      });

      proc.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      if (proc.stdin) {
        proc.stdin.write(prompt);
        proc.stdin.end();
      }

      proc.on("close", (code) => {
        if (stdoutBuffer.trim()) {
          try {
            const parsed = JSON.parse(stdoutBuffer);
            if (parsed?.msg) {
              handleMessage(parsed.msg);
            } else if (parsed?.type) {
              handleLegacyEvent(parsed);
            }
          } catch {
            logWarn("Harness", `Failed to parse Codex JSON tail: ${stdoutBuffer.slice(0, 200)}`);
          }
        }
        if (stderr.trim()) {
          logWarn("Harness", `Codex CLI stderr (${label}): ${stderr.trim().slice(0, 500)}`);
        }
        if (!logState.logged && logPrefix && mode !== "quiet") {
          logInfo(logPrefix, "codex: (no streaming events)");
        }
        if (code !== 0) {
          logInfo("Harness", `Codex CLI exited with code ${code} (${label}).`);
        } else {
          logInfo("Harness", `Codex CLI completed (${label}).`);
        }
        resolve({
          exitCode: code ?? 0,
          agentMessages,
          lastAgentMessage,
          stderr,
        });
      });

      proc.on("error", (err) => {
        reject(new Error(`Codex CLI spawn failed (${label}): ${err.message}`));
      });
    });
  }

  private async execCodexPrompt(prompt: string, label: string, model?: string): Promise<string> {
    const result = await this.execCodexJson(
      prompt,
      label,
      model,
      "audit",
      this.getCodexLogMode()
    );
    return result.agentMessages.join("\n");
  }

  private buildSpecAuditPlanPrompt(
    maxAreas: number,
    repoSummary: string,
    nonce: string,
    auditLens: string
  ): string {
    return `You are setting up an audit for a Looper-managed project.

Project spec:
---
${this.cfg.projectSpec.trim()}
---

${repoSummary}

Your job: decide how many reviewers (1-${maxAreas}) are needed and define
non-overlapping functional areas to audit. Use fewer areas for small codebases.
If you need more context, inspect the repo (git ls-files, rg, ls).
This audit's lens is "${auditLens}". Use ONLY this lens for every area.
Lens options: integration-testing, correctness, safety, maintainability.

OUTPUT FORMAT (MACHINE READABLE ONLY):
Return EXACTLY one block with valid JSON between the markers. Do not include any other text.

Schema:
{
  "areas": [
    {
      "id": "kebab-case-id",
      "title": "Area name",
      "focus": "What to review in this area",
      "lens": "integration-testing|correctness|safety|maintainability",
      "paths": ["optional/path", "optional/glob"],
      "rationale": "why this area matters"
    }
  ],
  "notes": ["optional notes"]
}

<<<CODEX_AUDIT_PLAN:${nonce}>>>
{"areas":[{"id":"kebab-case-id","title":"Area name","focus":"What to review in this area","lens":"${auditLens}","paths":["optional/path"],"rationale":"why this area matters"}],"notes":["optional notes"]}
<<<END_CODEX_AUDIT_PLAN:${nonce}>>>`;
  }

  private buildSpecAuditAreaPrompt(
    area: SpecAuditPlanArea,
    repoSummary: string,
    nonce: string
  ): string {
    const paths = (area.paths ?? []).join(", ");
    return `You are an AUDITOR for a Looper-managed project.

Project spec:
---
${this.cfg.projectSpec.trim()}
---

${repoSummary}

Area ID: ${area.id}
Area title: ${area.title}
Area focus: ${area.focus}
Lens: ${area.lens ?? "spec"}
Relevant paths: ${paths || "(none specified)"}

Audit this area using the lens above. Lens guide:
- integration-testing: cross-component flows, realistic scenarios, missing integration tests
- correctness: spec adherence, bugs, edge cases, test coverage gaps
- safety: security + reliability (input validation, auth, data exposure, failure handling)
- maintainability: refactor needs, docs/observability debt, unclear boundaries, perf smells
If the lens doesn't apply, say so in notes and still report clear issues you find.

How to audit:
- Run init.sh and tests; capture actual failures
- Use rg to find spec keywords in code
- Check for TODO/FIXME markers indicating incomplete work
- Look at recent git history for context
- Identify missing integration tests relevant to the area and lens
- If lens=integration-testing, prioritize new integration test tasks and run available integration tests

Evidence requirements:
- Cite specific file:line for code issues
- Include command output for test failures
- Quote spec text when claiming a spec violation; otherwise use spec_ref="n/a" or a brief rationale

Severity guide:
- HIGH: Spec requirement not met, data loss risk, security hole
- MEDIUM: Partial implementation, edge case failures, missing tests
- LOW: Minor deviations, documentation gaps

Do NOT:
- Modify any files
- Report issues outside your assigned area
- Drift away from your assigned lens unless you spot a clear, high-impact issue
- Flag style/formatting issues (focus on behavior)

OUTPUT FORMAT (MACHINE READABLE ONLY):
Return EXACTLY one block with valid JSON between the markers. Do not include any other text.

Schema:
{
  "area_id": "${area.id}",
  "status": "PASS" | "FAIL",
  "summary": "short summary",
  "issues": [
    {
      "category": "missing|incorrect|edge-case|untested|security|bug|refactor|performance|reliability|docs|observability|ux",
      "issue": "what is missing or wrong",
      "evidence": "file:line or command output",
      "severity": "high|medium|low",
      "spec_ref": "spec section or quote (or 'n/a')"
    }
  ],
  "notes": ["optional notes"]
}

<<<CODEX_AUDIT_AREA:${nonce}>>>
{"area_id":"${area.id}","status":"PASS","summary":"short summary","issues":[],"notes":["optional notes"]}
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
    return `You are synthesizing an audit for a Looper-managed project.

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
- If gaps are found, output new tasks only. Do NOT reopen existing tasks.
- Include integration test gaps, correctness issues, safety issues, and maintainability concerns when found.
- Create a new task for each distinct bug/issue, with clear details and verification steps.
- Prefer adding integration test tasks when cross-component behavior is unverified.
- Integration test tasks should include steps to add the test, run it, fix failures, and re-run.
- Avoid duplicate tasks; ensure any new task id is unique within task_list.json.
- If everything is covered, return PASS with empty arrays.

OUTPUT FORMAT (MACHINE READABLE ONLY):
Return EXACTLY one block with valid JSON between the markers. Do not include any other text.

Schema:
{
  "result": "PASS" | "FAIL",
  "new_tasks": [
    {
      "id": "kebab-case-id",
      "category": "functional|api|ui|infra|test|security|performance|docs|bug|refactor|reliability|observability|ux|audit",
      "description": "one sentence",
      "steps": ["manual verification step 1", "step 2"],
      "depends_on": ["optional-task-id"],
      "scope": ["optional/path"]
    }
  ],
  "summary": ["brief notes for humans"]
}

<<<CODEX_AUDIT_SYNTHESIS:${nonce}>>>
{"result":"PASS","new_tasks":[],"summary":["brief notes for humans"]}
<<<END_CODEX_AUDIT_SYNTHESIS:${nonce}>>>`;
  }

  private buildSpecAuditClaudePrompt(auditLens: string): string {
    return `You are running an audit for a Looper-managed project.

Project spec:
---
${this.cfg.projectSpec.trim()}
---

Your job:
- Verify the repo matches the spec, but focus this audit on a single lens.
- Lens options: integration-testing, correctness, safety, maintainability.
- This audit lens is "${auditLens}". Apply it thoroughly; do not try to cover all lenses.
- Run relevant checks (init.sh, tests) when available.
- If gaps exist, add new tasks to task_list.json.
- If everything matches the spec, do not add tasks.
- Propose integration test tasks when behavior crosses components or external boundaries.
- Integration test tasks should include steps to add tests, run them, fix failures, and rerun.

STRICT RULES:
- Do NOT change product code. Only update task_list.json and agent-progress.txt.
- Be concrete: each task must have clear steps to verify.
- Avoid duplicates; create new tasks instead of editing existing ones.
- Ensure any new task id is unique within task_list.json.
- Preserve task_list.json ordering and key order; do not reformat or reorder existing tasks.
- Append any new tasks to the end of task_list.json.

At the end:
- Append a concise entry to agent-progress.txt (aim for ~10 lines, one line per bullet)
  summarizing what you checked, tests/commands you ran, gaps you found, and how you
  resolved them (or note unresolved). Include a line with lens=${auditLens}.
- Commit changes with a message like "Audit: <brief summary>".
`;
  }

  /**
   * INTERNAL: Run the planning agent once.
   */
  private async runPlanningAgent(): Promise<void> {
    if (this.isCodexPrimary()) {
      await this.runCodexPlanningAgent();
      return;
    }

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

  private async runCodexPlanningAgent(): Promise<void> {
    logInfo("Harness", "Starting Codex planning agent session…");
    const nonce = randomUUID();
    const prompt = this.buildCodexPlanningPrompt(nonce);
    const result = await this.runCodexAgentPrompt(
      prompt,
      "planning",
      "CODEX_PLANNING_RESULT",
      nonce
    );

    if (!result.passed) {
      throw new Error("Codex planning agent reported failure");
    }

    const [hasTaskList, hasProgressLog, hasInit] = await Promise.all([
      pathExists(this.paths.taskList),
      pathExists(this.paths.progressLog),
      pathExists(this.paths.initScript),
    ]);
    const taskListValid = hasTaskList ? await this.isTaskListValid() : false;

    if (!hasTaskList || !hasProgressLog || !hasInit || !taskListValid) {
      throw new Error("Planning artifacts missing or invalid after Codex planning run");
    }

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
    let sawPromptTooLong = false;

    try {
      for await (const msg of stream) {
        this.defaultLogMessage(msg, phase);
        this.cfg.onMessage?.(msg, phase);

        if (msg.type === "assistant") {
          const content = (msg.message as any).content ?? [];
          for (const block of content) {
            if (block?.type === "text" && typeof block.text === "string") {
              if (this.isPromptTooLongText(block.text)) {
                sawPromptTooLong = true;
              }
            }
          }
        }

        if (msg.type === "result") {
          lastResult = msg;
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (sawPromptTooLong || this.isPromptTooLongText(errMsg)) {
        throw new Error(`[${phase}] Prompt is too long`);
      }
      throw err;
    }

    // Check for SDK errors after the stream completes
    if (lastResult && lastResult.type === "result" && lastResult.subtype !== "success") {
      const errorMsg = lastResult.errors?.join("; ") ?? "Unknown error";
      if (sawPromptTooLong || this.isPromptTooLongText(errorMsg)) {
        throw new Error(`[${phase}] Prompt is too long`);
      }
      throw new Error(
        `[${phase}] SDK query failed (${lastResult.subtype}): ${errorMsg}`
      );
    }
  }

  private async runCodexAgentPrompt(
    prompt: string,
    phase: HarnessPhase,
    marker: string,
    nonce: string
  ): Promise<CodexAgentResult> {
    const model = this.cfg.codexModel;
    const { agentMessages, exitCode } = await this.execCodexJson(
      prompt,
      phase,
      model,
      phase,
      this.getCodexLogMode(),
      [marker]
    );

    const output = agentMessages.join("\n");
    if (!output.trim()) {
      throw new Error(`Codex ${phase} produced no agent messages`);
    }
    const payload = this.parseCodexAgentResult(output, marker, nonce);
    const result = this.normalizeCodexResult(payload.result);
    const passed = result === "PASS" && exitCode === 0;

    if (!passed) {
      logWarn("Harness", `Codex ${phase} result=${result} exitCode=${exitCode}`);
    }

    return { passed, payload, exitCode, output };
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
    let sawPromptTooLong = false;

    try {
      for await (const msg of stream) {
        this.defaultLogMessage(msg, phase);
        this.cfg.onMessage?.(msg, phase);

        // Capture session ID from any message
        if ("session_id" in msg && msg.session_id && !sessionId) {
          sessionId = msg.session_id;
        }

        if (msg.type === "assistant") {
          const content = (msg.message as any).content ?? [];
          for (const block of content) {
            if (block?.type === "text" && typeof block.text === "string") {
              if (this.isPromptTooLongText(block.text)) {
                sawPromptTooLong = true;
              }
            }
          }
        }

        if (msg.type === "result") {
          lastResult = msg;
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (sawPromptTooLong || this.isPromptTooLongText(errMsg)) {
        const errors = this.isPromptTooLongText(errMsg)
          ? [errMsg]
          : ["prompt is too long", errMsg];
        return { sessionId, success: false, errors, errorSubtype: "exception" };
      }
      throw err;
    }

    const success = lastResult?.type === "result" && lastResult.subtype === "success";
    const errorSubtype = lastResult?.type === "result" ? lastResult.subtype : undefined;
    // Only non-success results have errors
    let errors: string[] | undefined = 
      lastResult?.type === "result" && lastResult.subtype !== "success"
        ? (lastResult as { errors?: string[] }).errors ?? []
        : undefined;
    if (!success && (errors === undefined || errors.length === 0) && sawPromptTooLong) {
      errors = ["prompt is too long"];
    }
    logInfo("Harness", `[${phase}] Session ended. success=${success}, lastResult.type=${lastResult?.type}, lastResult.subtype=${(lastResult as any)?.subtype}`);
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
    existingSessionId: string | null
  ): Promise<ReviewResult> {
    const reviewPrompt = existingSessionId
      ? this.buildReviewContinuationPrompt(task)
      : this.buildReviewPrompt(task);

    const reviewOptions: Options = {
      ...options,
      maxTurns: this.cfg.maxReviewTurns ?? DEFAULT_MAX_REVIEW_TURNS,
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
    try {
      const payloadRaw = this.extractCodexJson(text, "CODEX_REVIEW_RESULT");
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

  private isPromptTooLongText(text: string): boolean {
    const lowered = text.toLowerCase();
    return (
      lowered.includes("prompt is too long") ||
      lowered.includes("context length") ||
      lowered.includes("maximum context") ||
      lowered.includes("max tokens") ||
      lowered.includes("too many tokens") ||
      lowered.includes("prompt too large")
    );
  }

  private isPromptTooLong(result: SessionResult): boolean {
    const errors = result.errors ?? [];
    if (errors.length === 0) {
      return false;
    }
    return errors.some((error) => this.isPromptTooLongText(error));
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
      logInfo("Harness", `Saved review issues to ${issuesPath}`);
      return issuesPath;
    } catch (err) {
      logWarn("Harness", "Failed to write review issues file", err);
      return null;
    }
  }

  /**
   * INTERNAL: Run Codex CLI for code review.
   * Executes `codex exec` with a review prompt and parses the output.
   */
  private async runCodexReview(
    task: TaskSpec,
    isRerun: boolean
  ): Promise<ReviewResult> {
    const reviewNonce = randomUUID();
    const prompt = isRerun
      ? this.buildCodexReviewContinuationPrompt(task, reviewNonce)
      : this.buildCodexReviewPrompt(task, reviewNonce);

    const model = this.cfg.codexModel;
    logInfo("Harness", `Running Codex CLI review (model=${model ?? "default"}, task=${task.id})`);
    try {
      const { agentMessages, exitCode } = await this.execCodexJson(
        prompt,
        "review",
        model,
        "review",
        this.getCodexLogMode(),
        ["CODEX_REVIEW_RESULT"]
      );
      const output = agentMessages.join("\n");
      if (!output.trim()) {
        return {
          sessionId: null,
          passed: false,
          issues: ["Codex review produced no output"],
        };
      }

      let { passed, issues } = this.parseReviewResult(output);
      if (exitCode !== 0 && passed) {
        passed = false;
        issues = ["Codex review exited with a non-zero status"];
      }

      const issuesPath = passed ? null : await this.writeReviewIssues(task, issues, "codex");
      logInfo("review", `codex: result ${passed ? "PASS" : "FAIL"}${issues.length ? ` (${issues.length} issue(s))` : ""}`);

      return { sessionId: null, passed, issues, issuesPath };
    } catch (err) {
      logError("Harness", "Codex CLI review error", err);
      return {
        sessionId: null,
        passed: false,
        issues: [`Codex CLI review failed: ${err instanceof Error ? err.message : String(err)}`],
      };
    }
  }

  /**
   * Build the Codex review prompt for initial review.
   */
  private buildCodexReviewPrompt(task: TaskSpec, reviewNonce: string): string {
    const coordinationNote = "If PASS, you must update task_list.json and agent-progress.txt as described below.";
    return `You are a CODE REVIEWER auditing work on task: "${task.id}"

Task description: ${task.description}

IMPORTANT: The working agent has left changes UNCOMMITTED for you to review.
The working agent already ran tests. Trust their results unless the code looks broken.

REVIEW CHECKLIST:

1. Check what changed: git status && git diff

2. Verify the implementation meets the task description

3. Look for obvious issues (bugs, missing error handling, incomplete implementation)

4. Simplicity check: unnecessary complexity, over-abstraction, confusing names

REVIEW GUIDELINES:
- Focus on correctness: does the code do what the task asks?
- Fix minor issues yourself (typos, imports) rather than failing
- Only re-run tests if code looks suspicious

${coordinationNote}

${this.buildCodexReviewOutputFormat(task.id, reviewNonce)}

Begin your audit now.`;
  }

  /**
   * Build the Codex review prompt for re-review after fixes.
   */
  private buildCodexReviewContinuationPrompt(task: TaskSpec, reviewNonce: string): string {
    const coordinationNote = "If PASS, you must update task_list.json and agent-progress.txt as described below.";
    return `The working agent claims to have fixed the issues you identified for task "${task.id}".

IMPORTANT: Changes are UNCOMMITTED. Check staged/unstaged changes, not commits.

Re-verify:
1. Run: git status and git diff to see current changes
2. Check if each issue you raised has been addressed
3. Look for any NEW issues introduced by the fixes
4. Simplicity check: unnecessary complexity, over-abstraction, confusing names

Same guidelines: trust tests ran, fix minor issues yourself, only re-run if suspicious.

${coordinationNote}

${this.buildCodexReviewOutputFormat(task.id, reviewNonce)}`;
  }

  private buildCodexReviewOutputFormat(taskId: string, reviewNonce: string): string {
    const passActions = `If PASS, you MUST:
1. Update task_list.json: set "passes": true for "${taskId}"
2. Append to agent-progress.txt with a concise entry (aim for ~10 lines)
   noting what you reviewed, what you verified/tests run, any issues found, and how
   they were resolved (or note none).
3. Stage ALL changes: git add -A
4. Commit with message: "Complete ${taskId}: <brief description>"`;
    return `OUTPUT FORMAT (MACHINE READABLE ONLY):

Return EXACTLY one block with valid JSON between the markers. Do not include any other text.

<<<CODEX_REVIEW_RESULT:${reviewNonce}>>>
{"result":"<PASS|FAIL>","issues":["<issue with file:line reference>"],"verified":["<what you verified>"],"tests":["<tests you ran>"]}
<<<END_CODEX_REVIEW_RESULT:${reviewNonce}>>>

${passActions}`;
  }

  private buildCodexAgentOutputFormat(marker: string, nonce: string): string {
    return `OUTPUT FORMAT (MACHINE READABLE ONLY):

Return EXACTLY one block with valid JSON between the markers. Do not include any other text.
This output format overrides any earlier instructions about response formatting.
Use "PASS" only if all instructions above are completed and any required verification succeeded.

<<<${marker}:${nonce}>>>
{"result":"<PASS|FAIL>","notes":["<short notes>"],"tests":["<tests you ran>"]}
<<<END_${marker}:${nonce}>>>`;
  }

  /**
   * Ensure local working directory matches the remote GitHub repository if configured.
   * Clones when missing; otherwise fetches + hard resets to origin/<branch>.
   * Handles empty repos by initializing them locally first.
   */
  private async syncRepoFromRemote(): Promise<void> {
    logInfo("Harness", `Syncing from remote: ${this.repositoryUrl} (branch: ${this.branch})`);
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
      logInfo("Harness", `No local repo at ${this.workingDir}, cloning...`);
      await fs.mkdir(this.workingDir, { recursive: true });

      // Try to clone; if it fails due to empty repo, initialize locally
      try {
        await this.execGit(
          ["clone", "--branch", branchRef, "--single-branch", authUrl, this.workingDir],
          env
        );
        // Set the remote to the non-authenticated URL for display purposes
        await this.execGit(["-C", this.workingDir, "remote", "set-url", "origin", this.repositoryUrl], env);
        logInfo("Harness", `✓ Cloned repository successfully`);
        return;
      } catch (err: any) {
        const msg = err?.message ?? "";
        // Handle empty repo (no branches yet)
        if (msg.includes("Remote branch") && msg.includes("not found")) {
          logInfo("Harness", "Remote repo is empty, initializing locally...");
          await execFileAsync("git", ["init"], { cwd: this.workingDir, env });
          await execFileAsync("git", ["remote", "add", "origin", this.repositoryUrl], { cwd: this.workingDir, env });
          await execFileAsync("git", ["checkout", "-b", branchRef], { cwd: this.workingDir, env });
          logInfo("Harness", `✓ Initialized empty local repo`);
          return;
        }
        throw err;
      }
    }

    logInfo("Harness", `Local repo exists, fetching and resetting to origin/${branchRef}...`);
    // Update remote URL to authenticated version for fetch
    await this.execGit(["-C", this.workingDir, "remote", "set-url", "origin", authUrl], env);
    try {
      const remoteRef = `refs/remotes/origin/${branchRef}`;
      // Fetch with an explicit refspec so single-branch clones track the branch.
      await this.execGit(["-C", this.workingDir, "fetch", "--force", "origin", `+${branchRef}:${remoteRef}`], env);
      try {
        await this.execGit(["-C", this.workingDir, "reset", "--hard"], env);
        await this.execGit(["-C", this.workingDir, "clean", "-fd"], env);
      } catch {
        // Ignore cleanup failures; checkout will surface real errors.
      }
      await this.execGit(["-C", this.workingDir, "checkout", "-B", branchRef, remoteRef], env);
      await this.execGit(["-C", this.workingDir, "reset", "--hard", remoteRef], env);
      await this.execGit(["-C", this.workingDir, "clean", "-fd"], env);
      logInfo("Harness", `✓ Synced to origin/${branchRef}`);
    } catch (err: any) {
      const msg = err?.message ?? "";
      const isTaskBranch = branchRef.startsWith("task/");
      // Treat missing remote branches as fatal to avoid falling back to stale local state.
      if (
        msg.includes("couldn't find remote ref") ||
        msg.includes("unknown revision") ||
        msg.includes("not a commit") ||
        msg.includes("pathspec")
      ) {
        if (isTaskBranch) {
          throw new Error(
            `Remote branch ${branchRef} is missing; refusing to use local state.`
          );
        }

        const heads = await this.execGit(["-C", this.workingDir, "ls-remote", "--heads", "origin"], env);
        if (!heads.trim()) {
          logInfo("Harness", "Remote repo has no branches; reinitializing local repo...");
          await this.resetToEmptyRepo(branchRef, env);
          return;
        }

        throw new Error(
          `Remote branch ${branchRef} is missing; repo has other branches. Check --branch.`
        );
      }
      throw err;
    }
    // Reset remote URL to non-authenticated version
    await this.execGit(["-C", this.workingDir, "remote", "set-url", "origin", this.repositoryUrl], env);
  }

  private async resetToEmptyRepo(branchRef: string, env: NodeJS.ProcessEnv): Promise<void> {
    const entries = await fs.readdir(this.workingDir).catch(() => []);
    for (const entry of entries) {
      await fs.rm(path.join(this.workingDir, entry), { recursive: true, force: true });
    }
    await execFileAsync("git", ["init"], { cwd: this.workingDir, env });
    await execFileAsync("git", ["remote", "add", "origin", this.repositoryUrl], { cwd: this.workingDir, env });
    await execFileAsync("git", ["checkout", "-b", branchRef], { cwd: this.workingDir, env });
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
    logDebug("Harness", `git ${redactedArgs.join(" ")}`);
    try {
      const result = await execFileAsync("git", args, { env });
      const stdout = result.stdout?.toString().trim();
      if (stdout) {
        logDebug("Harness", `git output: ${stdout.substring(0, 200)}${stdout.length > 200 ? "..." : ""}`);
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
      logError("Harness", `git error: ${redactedStderr.substring(0, 500)}`);
      throw new Error(`Git command failed (${redactedArgs.join(" ")}): ${redactedStderr}`);
    }
  }

  private async appendAutoCommitNote(
    phase: HarnessPhase,
    context: AutoCommitContext
  ): Promise<void> {
    if (context.result === "PASS") return;
    if (phase !== "working" && phase !== "fixing") return;

    const taskLabel = context.taskId ?? "unknown";
    const outcome = context.result ?? "FAIL";
    const reason = context.reason
      ? truncateText(context.reason, 200)
      : "Agent did not report PASS before session ended.";
    const entry = [
      `[${new Date().toISOString()}] Auto-commit note (${phase})`,
      `- Task: ${taskLabel}`,
      `- Outcome: ${outcome}`,
      `- ${reason}`,
      "- Auto-commit created by harness for uncommitted changes.",
      `- Next session: review the "Auto-commit uncommitted changes (${phase})" commit before resuming.`,
      "",
    ].join("\n");

    try {
      await fs.appendFile(this.paths.progressLog, entry, "utf8");
    } catch (err) {
      logWarn("Harness", "Failed to append auto-commit note to agent-progress.txt", err);
    }
  }

  /** Push any unpushed commits to origin/<branch>. */
  private async pushIfNeeded(phase: HarnessPhase, context?: AutoCommitContext): Promise<void> {
    logInfo("Harness", `Checking for unpushed commits (${phase})...`);
    const needsToken = this.requiresGithubToken(this.repositoryUrl);
    if (needsToken && !this.gitToken) {
      throw new Error(
        `GITHUB_TOKEN is required to push changes to ${this.repositoryUrl}. Provide a token with repo scope before running ${phase}.`
      );
    }

    const env = this.buildGitEnv();

    // Check for uncommitted changes and auto-commit if needed
    try {
      const status = await execFileAsync("git", ["-C", this.workingDir, "status", "--porcelain"], { env });
      const uncommitted = status.stdout.trim();
      if (uncommitted) {
        if (context?.result && context.result !== "PASS") {
          await this.appendAutoCommitNote(phase, context);
        }
        logWarn("Harness", "Found uncommitted changes, auto-committing...");
        await this.ensureGitIdentity(env);
        await execFileAsync("git", ["-C", this.workingDir, "add", "-A"], { env });
        await execFileAsync("git", ["-C", this.workingDir, "commit", "-m", `Auto-commit uncommitted changes (${phase})`], { env });
        logInfo("Harness", `Auto-committed uncommitted changes`);
      }
    } catch (err) {
      logWarn("Harness", "Failed to check/commit uncommitted changes", err);
    }

    // Check if there are any commits at all
    let headSha: string | null = null;
    try {
      const result = await execFileAsync("git", ["-C", this.workingDir, "rev-parse", "HEAD"], { env });
      headSha = result.stdout.trim();
      logInfo("Harness", `Current HEAD: ${headSha}`);
    } catch {
      logInfo("Harness", `No commits yet, nothing to push.`);
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
      logInfo("Harness", `Unpushed commits: ${unpushedCommits.length}`);
      for (const commit of unpushedCommits) {
        logInfo("Harness", `  - ${commit}`);
      }
    } catch {
      // origin/<branch> doesn't exist yet, so all local commits are unpushed
      logInfo("Harness", `Remote branch origin/${this.branch} not found, all commits are unpushed`);
      unpushedCommits = ["all"];
    }

    if (unpushedCommits.length === 0) {
      logInfo("Harness", `No unpushed commits after ${phase} phase.`);
      return;
    }

    // Pull (rebase) then push to origin
    const authUrl = this.getAuthenticatedRepoUrl();
    logInfo("Harness", `Pushing to origin/${this.branch}...`);
    try {
      await this.execGit(["-C", this.workingDir, "remote", "set-url", "origin", authUrl], env);
      // First, try to pull with rebase in case remote has new commits
      try {
        logInfo("Harness", `Attempting pull --rebase first...`);
        await this.execGit(["-C", this.workingDir, "pull", "--rebase", "origin", this.branch], env);
      } catch (pullErr) {
        // Pull may fail if remote branch doesn't exist yet, that's OK
        logInfo("Harness", `Pull --rebase skipped or failed (may be expected): ${pullErr instanceof Error ? pullErr.message : pullErr}`);
      }
      // Use -u to set upstream if this is the first push
      logInfo("Harness", `Executing push...`);
      await this.execGit(["-C", this.workingDir, "push", "-u", "origin", this.branch], env);
      logInfo("Harness", `✓ Successfully pushed ${unpushedCommits.length} commit(s) to origin/${this.branch} (${phase}).`);
    } catch (err) {
      logError("Harness", `✗ Failed to push to origin/${this.branch}`, err);
      throw new Error(
        `Failed to push to origin/${this.branch}. Ensure GITHUB_TOKEN has repo push permissions.`
      );
    } finally {
      await this.execGit(["-C", this.workingDir, "remote", "set-url", "origin", this.repositoryUrl], env);
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
Create coordination artifacts (task_list.json, agent-progress.txt, init.sh,
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
      return `You are an AUDITOR for a Looper-managed project.
Your job is to check whether the implementation matches the project spec.
Only update coordination artifacts (task_list.json, agent-progress.txt).
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

3) Create agent-progress.txt at the repo root
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

  private buildCodexPlanningPrompt(nonce: string): string {
    return this.wrapWithCodexOutputFormat(
      this.buildPlanningPrompt(),
      "CODEX_PLANNING_RESULT",
      nonce
    );
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
  - Read CLAUDE.md and agent-progress.txt for recommended stack/approach.
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
   - Run "./init.sh --quick > .looper-init.log 2>&1" (fast mode, ~30 seconds).
   - If it fails, dedicate this session to fixing the environment first.
     * Inspect ".looper-init.log" (e.g. "tail -n 200 .looper-init.log").
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
- agent-progress.txt — log of previous work and instructions.
- init.sh — script to start the environment and run smoke tests.
- git log — history of previous changes.

NOTE: Coordination artifacts (task_list.json, agent-progress.txt, init.sh) go at repo root.
Project source code goes in appropriate subdirectories (src/, backend/, frontend/, etc.).

Your job in this session is to:
  1. Get oriented.
  2. ${task ? "Confirm your assigned task (see above)." : "Find the first failing task in task_list.json."}
  3. Implement it end-to-end.
  4. Verify it thoroughly.
  5. Leave the environment in a clean, working state.
  6. If you hit a bug or broken state, fix it immediately before proceeding.

Follow this checklist strictly:

1) Get your bearings
   - Run "pwd" to confirm the working directory.
   - Ensure the repo is on branch ${this.branch} and synced to origin/${this.branch}.
   - Read agent-progress.txt.
   - If agent-progress.txt mentions an auto-commit or git log shows a recent "Auto-commit uncommitted changes" commit, review that diff before continuing.
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
   - In agent-progress.txt:
       - Append a concise entry (aim for ~10 lines) noting:
           - Task id + outcome (pass/fail).
           - 1-2 lines on what you implemented or changed.
           - Key files changed (paths).
           - Verification/tests run (commands + results).
           - Challenges encountered (1-3 lines).
           - How you resolved each challenge (1-3 lines) or note unresolved.
           - Follow-ups/blockers for future agents.
       - Use one bullet per line; be concrete so future agents can skim fast.

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
  Ensure new task ids do not collide with existing ones; pick a new id if needed.
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

  /** Wrap a prompt with Codex output format instructions. */
  private wrapWithCodexOutputFormat(basePrompt: string, marker: string, nonce: string): string {
    return `${basePrompt}

At the end of your work, output the result in the exact format below.

${this.buildCodexAgentOutputFormat(marker, nonce)}
`;
  }

  private buildCodexWorkingPrompt(
    isProjectSetup: boolean,
    task: TaskSpec | undefined,
    nonce: string
  ): string {
    return this.wrapWithCodexOutputFormat(
      this.buildWorkingPrompt(isProjectSetup, task),
      "CODEX_WORKING_RESULT",
      nonce
    );
  }

  private buildCodexWorkingPromptForReview(
    isProjectSetup: boolean,
    task: TaskSpec,
    nonce: string
  ): string {
    return this.wrapWithCodexOutputFormat(
      this.buildWorkingPromptForReview(isProjectSetup, task),
      "CODEX_WORKING_RESULT",
      nonce
    );
  }

  private buildCodexFixPrompt(
    issues: string[],
    issuesPath: string | null | undefined,
    nonce: string
  ): string {
    return this.wrapWithCodexOutputFormat(
      this.buildFixPrompt(issues, issuesPath),
      "CODEX_WORKING_RESULT",
      nonce
    );
  }

  private buildCompactWorkingPrompt(isProjectSetup: boolean, task?: TaskSpec): string {
    const taskAssignment = task
      ? `
ASSIGNED TASK: ${task.id}
Description: ${task.description}
Steps:
${task.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}
`
      : "";

    const projectSetupSection = isProjectSetup
      ? `
Project-setup:
- Choose and scaffold a sensible stack.
- Update init.sh to install dependencies and run a smoke test.
- Ensure ./init.sh passes before finishing.
`
      : "";

    const verifyEnvironmentSection = isProjectSetup
      ? ""
      : `
Environment:
- Run "./init.sh --quick > .looper-init.log 2>&1".
- If it fails, check "tail -n 200 .looper-init.log".
- If it fails, fix the environment before the task.
`;

    return `
You are a working agent on a long-running project.
${taskAssignment}${projectSetupSection}
Keep context small:
- Avoid dumping large files or logs.
- Use rg/jq/sed with limits (head/tail) for big files.
- Only read the portions you need.

Key files at repo root: CLAUDE.md, SPEC.md, task_list.json, agent-progress.txt, init.sh.
If agent-progress.txt mentions an auto-commit or git log shows "Auto-commit uncommitted changes", review that diff before continuing.
${verifyEnvironmentSection}
Implement the task end-to-end and verify using the task steps.

Finish:
- Update task_list.json to mark the task passing.
- Update agent-progress.txt with a concise entry.
- Commit with a focused message.

Explain what you changed and list commands you ran.
`;
  }

  /** Review mode suffix - full version with detailed instructions. */
  private readonly REVIEW_MODE_SUFFIX_FULL = `
═══════════════════════════════════════════════════════════════════════════════
CRITICAL OVERRIDE - REVIEW MODE ACTIVE
═══════════════════════════════════════════════════════════════════════════════
You are in REVIEW MODE. A separate review agent will audit your work.

DO NOT:
- Update task_list.json to set "passes": true
- Write to agent-progress.txt
- Mark the task as complete in any way
- Run "git commit" - leave your changes UNCOMMITTED

DO:
- Implement the task fully
- Run tests and verify they pass
- Stage your changes with "git add" but DO NOT COMMIT
- The review agent will verify, update task_list.json, and commit everything together
═══════════════════════════════════════════════════════════════════════════════`;

  /** Review mode suffix - compact version. */
  private readonly REVIEW_MODE_SUFFIX_COMPACT = `
REVIEW MODE:
- Do NOT edit task_list.json or agent-progress.txt.
- Do NOT commit.
- Stage changes with "git add".
`;

  /**
   * Build the working prompt for review mode - implementation without marking complete.
   */
  private buildWorkingPromptForReview(isProjectSetup: boolean, task: TaskSpec): string {
    return this.buildWorkingPrompt(isProjectSetup, task) + this.REVIEW_MODE_SUFFIX_FULL;
  }

  private buildCompactWorkingPromptForReview(isProjectSetup: boolean, task: TaskSpec): string {
    return this.buildCompactWorkingPrompt(isProjectSetup, task) + this.REVIEW_MODE_SUFFIX_COMPACT;
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
Ensure new task ids do not collide with existing ones; pick a new id if needed.

After completing your work:
- Stage your changes with "git add" but DO NOT COMMIT
- The review agent will verify and commit everything together if it passes
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
2. Append to agent-progress.txt with a concise entry (aim for ~10 lines)
   noting what you reviewed, what you verified/tests run, any issues found, and how
   they were resolved (or note none).
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

No prior context. Changes are UNCOMMITTED (staged/unstaged), not commits.

Your job: find problems. Be skeptical.

REVIEW CHECKLIST:
1) Inspect changes: git status; git diff --stat; git diff; git diff --cached
2) Verify task requirements and behavior; watch for stubs/TODOs/missing error handling
3) Simplicity check: unnecessary complexity, over-abstraction, confusing names, dead code
4) Tests: run relevant tests unless clearly unrelated; confirm they actually execute

RED FLAGS (fail):
- Ignored/skipped tests or "--no-run"
- Stubs (unimplemented!/todo!/placeholder)
- Tests that don't assert behavior

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

If PASS, do ALL in ONE ATOMIC COMMIT:
1. Update task_list.json: set "passes": true for "${task.id}"
2. Append to agent-progress.txt with a concise entry (~10 lines)
3. Stage ALL changes: git add -A
4. Commit EVERYTHING with message:
   "Complete ${task.id}: <brief description of what was implemented>"

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
2. Append to agent-progress.txt with a concise entry (aim for ~10 lines)
   noting what you reviewed, what you verified/tests run, any issues found, and how
   they were resolved (or note none).
3. Stage ALL changes: git add -A
4. Commit EVERYTHING together with message:
   "Complete ${task.id}: <brief description>"
`;
  }

  private async isTaskListValid(): Promise<boolean> {
    try {
      await this.readTaskList();
      return true;
    } catch (err) {
      logWarn("Harness", "Invalid task_list.json detected.", err);
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

      // Build properly typed TaskSpec after validation
      const task: TaskSpec = {
        id: record.id as string,
        category: record.category as string,
        description: record.description as string,
        steps: record.steps as string[],
        ...(record.passes !== undefined ? { passes: record.passes as boolean } : {}),
        ...(record.depends_on !== undefined ? { depends_on: record.depends_on as string[] } : {}),
        ...(record.scope !== undefined ? { scope: record.scope as string[] } : {}),
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

    logWarn(
      "Harness",
      `Duplicate task ids detected; using last occurrence for: ${duplicates.join(", ")}`
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
      logWarn(
        "Harness",
        "Invalid task_list.json; treating remaining tasks as unknown.",
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
          logInfo(phase, `Session started (model=${msg.model}, permissionMode=${msg.permissionMode})`);
        } else if (msg.subtype === "compact_boundary") {
          logInfo(phase, `--- context compacted (trigger=${msg.compact_metadata.trigger}, pre_tokens=${msg.compact_metadata.pre_tokens})`);
        }
        break;

      case "assistant": {
        // Try to extract text blocks from the Anthropic message payload.
        const content = (msg.message as any).content ?? [];
        for (const block of content) {
          if (block?.type === "text" && typeof block.text === "string") {
            logInfo(phase, `assistant: ${block.text}`);
          } else if (block?.type === "tool_use") {
            // Log tool name and a brief summary of input
            const inputSummary = this.summarizeToolInput(block.name, block.input);
            if (inputSummary) {
              logInfo(phase, `tool: ${inputSummary}`);
            } else {
              logInfo(phase, `tool: ${block.name}`);
            }
          }
        }
        break;
      }

      case "result":
        if (msg.subtype === "success") {
          logInfo(phase, `✓ result: turns=${msg.num_turns}, duration=${msg.duration_ms}ms, cost=$${msg.total_cost_usd.toFixed(4)}`);
        } else {
          logWarn(
            phase,
            `✗ result (${msg.subtype}): turns=${msg.num_turns}, errors=${msg.errors?.join("; ")}`
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
          if (!input.command) return "Bash";
          return `Bash -> ${input.command.substring(0, 80)}${input.command.length > 80 ? "..." : ""}`;
        case "Read":
        case "Write":
          return input.file_path ? `${toolName} -> ${input.file_path.split("/").slice(-2).join("/")}` : toolName;
        case "Edit":
          return input.file_path ? `Edit -> ${input.file_path.split("/").slice(-2).join("/")}` : "Edit";
        case "TodoWrite": {
          const count = Array.isArray(input.todos) ? input.todos.length : undefined;
          return count !== undefined ? `TodoWrite -> updated ${count} item(s)` : "TodoWrite -> updated plan";
        }
        case "Glob":
          return input.pattern ? `Glob -> ${input.pattern}` : "Glob";
        case "Grep":
          return input.pattern ? `Grep -> ${input.pattern.substring(0, 60)}` : "Grep";
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
