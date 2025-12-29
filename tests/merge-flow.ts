import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { LongRunningHarness, type TaskSpec } from "../harness.js";

const execFileAsync = promisify(execFile);

const runGit = (args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }) =>
  execFileAsync("git", args, {
    ...opts,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(opts?.env ?? {}) },
  });

const writeFile = (dir: string, name: string, contents: string) =>
  fs.writeFile(path.join(dir, name), contents, "utf8");

const assert = (condition: unknown, message: string) => {
  if (!condition) {
    throw new Error(message);
  }
};

async function createRemoteRepo(task: TaskSpec): Promise<{ remoteDir: string; branch: string }> {
  const branch = "main";
  const remoteDir = await fs.mkdtemp(path.join(os.tmpdir(), "merge-flow-remote-"));
  await runGit(["init", "--bare"], { cwd: remoteDir });

  const seedDir = await fs.mkdtemp(path.join(os.tmpdir(), "merge-flow-seed-"));
  await runGit(["init"], { cwd: seedDir });

  const taskList = [{ ...task, completed: false }];
  await writeFile(seedDir, "task_list.json", JSON.stringify(taskList, null, 2) + "\n");
  await writeFile(seedDir, "agent-progress.txt", "init\n");
  await writeFile(seedDir, "init.sh", "#!/usr/bin/env bash\ntrue\n");
  await writeFile(seedDir, "README.md", "init\n");

  await runGit(["add", "."], { cwd: seedDir });
  await runGit(
    ["-c", "user.email=test@example.com", "-c", "user.name=tester", "commit", "-m", "init"],
    { cwd: seedDir }
  );
  await runGit(["branch", "-M", branch], { cwd: seedDir });
  await runGit(["remote", "add", "origin", remoteDir], { cwd: seedDir });
  await runGit(["push", "-u", "origin", branch], { cwd: seedDir });

  await fs.rm(seedDir, { recursive: true, force: true });
  return { remoteDir, branch };
}

async function main() {
  const task: TaskSpec = {
    id: "merge-flow",
    category: "functional",
    description: "Test merge flow",
    steps: ["merge worker task into main"],
  };

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "merge-flow-"));
  let remoteDir: string | null = null;

  try {
    const remote = await createRemoteRepo(task);
    remoteDir = remote.remoteDir;

    const workerDir = path.join(tmpRoot, "worker");
    await runGit(["clone", "--branch", remote.branch, "--single-branch", remoteDir, workerDir]);

    const taskBranch = `task/${task.id}`;
    await runGit(["checkout", "-b", taskBranch], { cwd: workerDir });
    await writeFile(workerDir, "feature.txt", "done\n");
    await runGit(["add", "feature.txt"], { cwd: workerDir });
    await runGit(
      ["-c", "user.email=test@example.com", "-c", "user.name=tester", "commit", "-m", `Task ${task.id}: add feature`],
      { cwd: workerDir }
    );
    await runGit(["push", "-u", "origin", taskBranch], { cwd: workerDir });

    const harness = new LongRunningHarness({
      workingDir: workerDir,
      projectSpec: "Spec",
      repositoryUrl: remoteDir,
      branch: taskBranch,
      baseBranch: remote.branch,
    });

    await (harness as any).finalizeWorkerTask(task);

    const verifyDir = path.join(tmpRoot, "verify");
    await runGit(["clone", "--branch", remote.branch, "--single-branch", remoteDir, verifyDir]);

    const head = await runGit(["log", "--format=%s", "-1"], { cwd: verifyDir });
    const headMessage = head.stdout.toString().trim();
    assert(headMessage === `Complete ${task.id}: ${task.description}`, "Unexpected main branch HEAD message.");

    const taskListRaw = await fs.readFile(path.join(verifyDir, "task_list.json"), "utf8");
    const taskList = JSON.parse(taskListRaw) as TaskSpec[];
    const entry = taskList.find((item) => item.id === task.id);
    assert(entry?.completed === true, "Task not marked as complete in task_list.json.");

    await runGit(["fetch", "origin", `+${taskBranch}:refs/remotes/origin/${taskBranch}`], { cwd: verifyDir });
    const mainSha = (await runGit(["rev-parse", `origin/${remote.branch}`], { cwd: verifyDir })).stdout.toString().trim();
    const taskSha = (await runGit(["rev-parse", `origin/${taskBranch}`], { cwd: verifyDir })).stdout.toString().trim();
    assert(mainSha === taskSha, "Task branch did not fast-forward into main.");

    const commitCount = await runGit(["rev-list", "--count", `origin/${remote.branch}`], { cwd: verifyDir });
    assert(commitCount.stdout.toString().trim() === "2", "Unexpected number of commits on main.");

    console.log("merge-flow: OK");
  } finally {
    if (remoteDir) {
      await fs.rm(remoteDir, { recursive: true, force: true });
    }
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("merge-flow: FAILED");
  console.error(err);
  process.exit(1);
});
