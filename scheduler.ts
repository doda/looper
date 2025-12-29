import { TaskSpec } from "./harness.js";

export type TaskId = string;

export interface TaskScheduleOptions {
  inProgress: Set<TaskId>;
  inProgressTasks?: TaskSpec[];
}

function normalizeDependencies(tasks: TaskSpec[]): Map<TaskId, TaskId[]> {
  const deps = new Map<TaskId, TaskId[]>();

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const hasExplicit = task.depends_on !== undefined;
    const explicit = (task.depends_on ?? []).filter((id) => typeof id === "string" && id.trim() !== "");
    if (hasExplicit) {
      deps.set(task.id, explicit);
      continue;
    }

    // No dependencies specified means the task is ready when not blocked by scope.
    deps.set(task.id, []);
  }

  return deps;
}

function hasScopeConflict(taskA: TaskSpec, taskB: TaskSpec): boolean {
  const scopeA = taskA.scope ?? [];
  const scopeB = taskB.scope ?? [];
  if (scopeA.length === 0 || scopeB.length === 0) return false;

  const setA = new Set(scopeA);
  for (const entry of scopeB) {
    if (setA.has(entry)) return true;
  }

  return false;
}

export function getReadyTasks(tasks: TaskSpec[], options: TaskScheduleOptions): TaskSpec[] {
  const deps = normalizeDependencies(tasks);
  const passing = new Set(tasks.filter((t) => t.completed === true).map((t) => t.id));
  const inProgressTasks = options.inProgressTasks ?? [];

  const ready = tasks.filter((task) => {
    if (task.completed === true) return false;
    if (options.inProgress.has(task.id)) return false;

    const taskDeps = deps.get(task.id) ?? [];
    for (const dep of taskDeps) {
      if (!passing.has(dep)) return false;
    }

    for (const active of inProgressTasks) {
      if (hasScopeConflict(task, active)) return false;
    }

    return true;
  });

  return ready;
}
