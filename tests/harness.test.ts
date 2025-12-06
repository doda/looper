import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LongRunningHarness } from "../harness.js";
import { query as mockedQuery, type Query } from "@anthropic-ai/claude-agent-sdk";

vi.mock("@anthropic-ai/claude-agent-sdk", () => {
  const query = vi.fn();
  return { query };
});

const execFileAsync = promisify(execFile);

const makeSuccessStream = () =>
  (async function* () {
    yield { type: "assistant", message: { content: [{ type: "text", text: "ok" }] } } as any;
    yield {
      type: "result",
      subtype: "success",
      num_turns: 1,
      duration_ms: 0,
      total_cost_usd: 0,
    } as any;
  })();

const makeSuccessQuery = (): Query => {
  const iterator = makeSuccessStream();
  return {
    ...iterator,
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    setMaxThinkingTokens: async () => {},
    supportedCommands: async () => [],
    supportedModels: async () => [],
    mcpServerStatus: async () => [],
    accountInfo: async () => ({} as any),
    streamInput: async () => {},
    [Symbol.asyncIterator]() {
      return iterator;
    },
  } as Query;
};

const writeFile = (dir: string, name: string, contents: string) =>
  fs.writeFile(path.join(dir, name), contents, "utf8");

const runGit = (args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) =>
  execFileAsync("git", args, {
    ...opts,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(opts?.env ?? {}) },
  });

async function createRemoteWithFiles(files: Record<string, string>): Promise<{ remote: string; branch: string }> {
  const branch = "main";
  const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-remote-"));
  await runGit(["init", "--bare"], { cwd: remoteDir });

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-work-"));
  await runGit(["init"], { cwd: workDir });

  for (const [name, contents] of Object.entries(files)) {
    await writeFile(workDir, name, contents);
  }

  // Ensure there is at least one file so the branch exists.
  if (Object.keys(files).length === 0) {
    await writeFile(workDir, "README.md", "init");
  }

  await runGit(["add", "."], { cwd: workDir });
  await runGit(["-c", "user.email=test@example.com", "-c", "user.name=tester", "commit", "-m", "init"], { cwd: workDir });
  await runGit(["branch", "-M", branch], { cwd: workDir });
  await runGit(["remote", "add", "origin", remoteDir], { cwd: workDir });
  await runGit(["push", "-u", "origin", branch], { cwd: workDir });

  await fs.rm(workDir, { recursive: true, force: true });
  return { remote: remoteDir, branch };
}

describe("LongRunningHarness", () => {
  let tmpDir: string;
  let remoteRepo: { remote: string; branch: string };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-test-"));
    remoteRepo = await createRemoteWithFiles({ README: "init" });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(remoteRepo.remote, { recursive: true, force: true });
  });

  it("runs the initializer when artifacts are missing", async () => {
    vi.mocked(mockedQuery).mockImplementation(() => makeSuccessQuery());
    const harness = new LongRunningHarness({
      workingDir: tmpDir,
      projectSpec: "Spec",
      repositoryUrl: remoteRepo.remote,
      branch: remoteRepo.branch,
    });

    await harness.ensureInitialized();

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const call = (mockedQuery as any).mock.calls[0][0];
    expect(call.prompt).toContain("You are the first engineer");
  });

  it("skips the initializer when all artifacts are present and valid", async () => {
    const featureList = [
      { id: "f1", category: "functional", description: "a", steps: ["step"], passes: false },
    ];
    const { remote, branch } = await createRemoteWithFiles({
      "feature_list.json": JSON.stringify(featureList, null, 2),
      "claude-progress.txt": "log",
      "init.sh": "#!/usr/bin/env bash\necho ok\n",
    });

    vi.mocked(mockedQuery).mockImplementation(() => makeSuccessQuery());
    const harness = new LongRunningHarness({
      workingDir: tmpDir,
      projectSpec: "Spec",
      repositoryUrl: remote,
      branch,
    });

    await harness.ensureInitialized();

    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("clones from a remote repository when provided", async () => {
    const { remote, branch } = await createRemoteWithFiles({
      "feature_list.json": JSON.stringify(
        [{ id: "f1", category: "functional", description: "a", steps: ["step"], passes: false }],
        null,
        2
      ),
      "claude-progress.txt": "log",
      "init.sh": "#!/usr/bin/env bash\necho ok\n",
    });
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-clone-"));

    const harness = new LongRunningHarness({
      workingDir: workDir,
      projectSpec: "Spec",
      repositoryUrl: remote,
      branch,
    });

    await harness.ensureInitialized();

    const gitExists = await fs.stat(path.join(workDir, ".git"));
    expect(gitExists.isDirectory()).toBe(true);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it("re-runs the initializer when feature_list.json is invalid", async () => {
    const { remote, branch } = await createRemoteWithFiles({
      "feature_list.json": "not json",
      "claude-progress.txt": "log",
      "init.sh": "#!/usr/bin/env bash\necho ok\n",
    });

    vi.mocked(mockedQuery).mockImplementation(() => makeSuccessQuery());
    const harness = new LongRunningHarness({
      workingDir: tmpDir,
      projectSpec: "Spec",
      repositoryUrl: remote,
      branch,
    });

    await harness.ensureInitialized();

    expect(mockedQuery).toHaveBeenCalledTimes(1);
  });

  it("counts remaining features correctly", async () => {
    const featureList = [
      { id: "f1", category: "functional", description: "a", steps: ["step"], passes: false },
      { id: "f2", category: "functional", description: "b", steps: ["step"], passes: true },
      { id: "f3", category: "functional", description: "c", steps: ["step"] },
    ];
    const { remote, branch } = await createRemoteWithFiles({
      "feature_list.json": JSON.stringify(featureList, null, 2),
    });

    // Pre-clone so countRemainingFeatures can read the file without running the initializer.
    await runGit(["clone", "--branch", branch, "--single-branch", remote, tmpDir]);

    const harness = new LongRunningHarness({
      workingDir: tmpDir,
      projectSpec: "Spec",
      repositoryUrl: remote,
      branch,
    });

    const remaining = await (harness as any).countRemainingFeatures();

    expect(remaining).toBe(2);
  });
});
