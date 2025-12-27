import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { LongRunningHarness } from "../harness.js";
import { buildWorkerEnv, getRemoteTaskBranchInfo } from "../run.js";

const execFileAsync = promisify(execFile);

const runGit = (args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) =>
  execFileAsync("git", args, {
    ...opts,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(opts?.env ?? {}) },
  });

const writeFile = (dir: string, name: string, contents: string) =>
  fs.writeFile(path.join(dir, name), contents, "utf8");

const tmpDirs: string[] = [];

const makeTmpDir = async (prefix: string) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
};

async function createRemoteWithFiles(files: Record<string, string>): Promise<{ remote: string; branch: string }> {
  const branch = "main";
  const remoteDir = await makeTmpDir("run-remote-");
  await runGit(["init", "--bare"], { cwd: remoteDir });

  const workDir = await makeTmpDir("run-work-");
  await runGit(["init"], { cwd: workDir });

  for (const [name, contents] of Object.entries(files)) {
    await writeFile(workDir, name, contents);
  }

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

afterEach(async () => {
  await Promise.all(tmpDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  tmpDirs.length = 0;
});

describe("parallel controller + git plumbing regressions", () => {
  it("keeps task branches visible after non-fast-forward updates", async () => {
    const remoteDir = await makeTmpDir("run-remote-task-");
    await runGit(["init", "--bare"], { cwd: remoteDir });

    const authorDir = await makeTmpDir("run-author-");
    await runGit(["init"], { cwd: authorDir });
    await writeFile(authorDir, "README.md", "init");
    await runGit(["add", "."], { cwd: authorDir });
    await runGit(["-c", "user.email=test@example.com", "-c", "user.name=tester", "commit", "-m", "init"], { cwd: authorDir });
    await runGit(["branch", "-M", "main"], { cwd: authorDir });
    await runGit(["remote", "add", "origin", remoteDir], { cwd: authorDir });
    await runGit(["push", "-u", "origin", "main"], { cwd: authorDir });

    await runGit(["checkout", "-b", "task/123"], { cwd: authorDir });
    await writeFile(authorDir, "task.txt", "initial");
    await runGit(["add", "."], { cwd: authorDir });
    await runGit(["-c", "user.email=test@example.com", "-c", "user.name=tester", "commit", "-m", "task"], { cwd: authorDir });
    await runGit(["push", "-u", "origin", "task/123"], { cwd: authorDir });

    const controllerDir = await makeTmpDir("run-controller-");
    await runGit(["clone", remoteDir, controllerDir]);

    const initial = await getRemoteTaskBranchInfo(controllerDir, remoteDir);
    expect(initial.has("123")).toBe(true);

    await runGit(["checkout", "--orphan", "task/123-rewrite"], { cwd: authorDir });
    await runGit(["clean", "-fdx"], { cwd: authorDir });
    await writeFile(authorDir, "task.txt", "rewrite");
    await runGit(["add", "."], { cwd: authorDir });
    await runGit(["-c", "user.email=test@example.com", "-c", "user.name=tester", "commit", "-m", "rewrite"], { cwd: authorDir });
    await runGit(["push", "--force", "origin", "task/123-rewrite:task/123"], { cwd: authorDir });

    const updated = await getRemoteTaskBranchInfo(controllerDir, remoteDir);
    expect(updated.has("123")).toBe(true);
  });

  it("keeps branch upstream on origin and updates origin/<branch> after push", async () => {
    const { remote, branch } = await createRemoteWithFiles({ README: "init" });
    const workDir = await makeTmpDir("run-worker-");
    await runGit(["clone", "--branch", branch, "--single-branch", remote, workDir]);

    await writeFile(workDir, "change.txt", "change");
    await runGit(["add", "."], { cwd: workDir });
    await runGit(["-c", "user.email=test@example.com", "-c", "user.name=tester", "commit", "-m", "change"], { cwd: workDir });

    const harness = new LongRunningHarness({
      workingDir: workDir,
      projectSpec: "Spec",
      repositoryUrl: remote,
      branch,
    });

    await (harness as any).pushIfNeeded("working");

    const remoteSetting = (await runGit(["-C", workDir, "config", "--get", `branch.${branch}.remote`])).stdout
      .toString()
      .trim();
    expect(remoteSetting).toBe("origin");

    const originSha = (await runGit(["-C", workDir, "rev-parse", `origin/${branch}`])).stdout.toString().trim();
    const headSha = (await runGit(["-C", workDir, "rev-parse", "HEAD"])).stdout.toString().trim();
    expect(originSha).toBe(headSha);
  });

  it("propagates REPOSITORY_BASE_BRANCH overrides to workers", () => {
    const originalBase = process.env.REPOSITORY_BASE_BRANCH;
    process.env.REPOSITORY_BASE_BRANCH = "develop";

    try {
      const env = buildWorkerEnv({
        workerConfig: {
          projectName: "demo",
          instruction: "Spec",
          sessions: 1,
          cpu: 1,
          memoryMb: 512,
          timeoutSecs: 0,
          repoUrl: "file:///tmp/repo",
          branch: "main",
          model: "sonnet",
        },
        projectName: "demo",
        repoUrl: "file:///tmp/repo",
        branch: "main",
        task: { id: "task-1", category: "functional", description: "d", steps: ["s"] },
        slot: 1,
      });

      expect(env.REPOSITORY_BASE_BRANCH).toBe("develop");
    } finally {
      if (originalBase === undefined) {
        delete process.env.REPOSITORY_BASE_BRANCH;
      } else {
        process.env.REPOSITORY_BASE_BRANCH = originalBase;
      }
    }
  });
});
