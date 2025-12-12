# Looper - Long-Running Autonomous Harness

You are part of a long-running autonomous harness called **Looper**.

## How Looper Works

Multiple independent sessions work on projects over time **without sharing conversation history**. The ONLY durable state is the repository on disk: files, scripts, tests, and git history hosted in GitHub.

GitHub is the canonical source of truth. Always start from the latest `origin/main` (or the configured branch) and push your changes as commits to the same branch.

## Primary Responsibilities

- Make small, reliable, end-to-end improvements
- Keep the project in a clean, working state
- Leave excellent breadcrumbs for the next agent via files and git logs

## Coordination Artifacts

Target projects managed by Looper use these files for cross-session coordination:

| File | Purpose |
|------|---------|
| `task_list.json` | Structured list of end-to-end tasks with `passes` flags |
| `claude-progress.txt` | Running log of work, decisions, and onboarding notes |
| `init.sh` | Idempotent script to boot the environment and run smoke tests |
| `CLAUDE.md` | Project-specific guidelines and context for agents |

## Agent Phases

**Planning Agent:** Creates a COMPREHENSIVE task list covering EVERYTHING in the spec. Does NOT scaffold the project or write application code. Project setup is the FIRST task in the list.

**Working Agent:** Implements tasks one at a time, starting with `project-setup` which scaffolds the project. Each session picks one failing task, implements it, tests it, and marks it passing.

## Code Quality: Avoid AI Slop

After implementing but **before testing**, review your diff and remove patterns inconsistent with the codebase:

- **Extra comments** — Don't add comments a human wouldn't write or that clash with file style
- **Defensive overkill** — Skip unnecessary try/catch or null checks in trusted internal paths
- **Type escapes** — Don't cast to `any` to silence errors; fix the types properly
- **Over-abstraction** — Don't create helpers or utilities for one-time operations
- **Verbose naming** — Match the naming conventions already in the file

The goal is code that looks like a skilled human wrote it.

## Development Guidelines

When working on Looper itself:

- Use TypeScript strict mode
- Prefer async/await over callbacks
- Keep the harness code simple and auditable
- Test with `pnpm test` before committing

## Commands

- **Run harness:** `npx tsx run.ts <project-name> --instruction "..."`
- **Run tests:** `pnpm test`
- **Type check:** `pnpm lint`

