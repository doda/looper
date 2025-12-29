# Looper

A long-running autonomous harness for building software projects. Looper orchestrates AI agents (Claude or OpenAI Codex) across multiple independent sessions, with each session picking up where the last left off via coordination artifacts stored in git.

## Quick Start

```bash
# Install dependencies
pnpm install

# Run the harness (default: Codex as primary agent)
npx tsx run.ts zinsta --instruction "Build an Instagram clone in Zig"

# Or use Claude as primary agent
npx tsx run.ts my-project --instruction "Build X" --primary-agent claude
```

### Environment

```bash
export GITHUB_OWNER=your-username    # Derive repo URL from owner + project name
export GITHUB_TOKEN=ghp_xxx          # Required for private repos
codex auth login                     # One-time Codex auth (or set ANTHROPIC_API_KEY for Claude)
```

## Architecture

Looper uses a **two-agent architecture** running inside isolated [Modal](https://modal.com) sandboxes:

```
┌─────────────────────────────────────────┐
│  Local Machine                          │
│  ┌───────────────────────────────────┐  │
│  │  run.ts (orchestrator)            │  │
│  │  - Creates Modal sandbox          │  │
│  │  - Uploads code + spec            │  │
│  │  - Streams logs                   │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────┐
│  Modal Sandbox                          │
│  ┌───────────────────────────────────┐  │
│  │  LongRunningHarness               │  │
│  │  - Planning Agent (first session) │  │
│  │  - Working Agent (subsequent)     │  │
│  │  - Review Agent (optional)        │  │
│  │  - Spec Audit (continuous mode)   │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  Persistent Volume                │  │
│  │  - Project files + git history    │  │
│  │  - Coordination artifacts         │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

### Agent Roles

| Agent | When | Purpose |
|-------|------|---------|
| **Planning Agent** | First session | Analyzes spec, creates task list & coordination artifacts |
| **Working Agent** | Each session | Picks one failing task, implements end-to-end, verifies |
| **Review Agent** | Optional | Audits changes, working agent fixes until approved |
| **Spec Auditor** | Continuous mode | Finds gaps when all tasks pass, adds new work |

### Coordination Artifacts

| File | Purpose |
|------|---------|
| `task_list.json` | Tasks with `completed` flags, dependencies, and scopes |
| `agent-progress.txt` | Running log of work and decisions |
| `init.sh` | Idempotent script to boot environment and run smoke tests |
| `CLAUDE.md` | Project context and guidelines for agents |

## Primary Agent Selection

| Agent | Flag | Notes |
|-------|------|-------|
| **Codex** (default) | `--primary-agent codex` | OpenAI Codex CLI |
| **Claude** | `--primary-agent claude` | Claude Agent SDK |

## Review Agent (Ping-Pong Flow)

Enable adversarial code review between working and review agents:

```bash
npx tsx run.ts my-project --instruction "Build X" --enable-review
```

**Flow:**
1. Working agent implements the task
2. Review agent audits (fresh context, adversarial)
3. If issues found: working agent fixes
4. Repeat until review passes or max iterations (default: 5)
5. Only push to git after review approval

The review agent defaults to Codex. Use `--review-agent claude` for Claude reviews (requires Claude primary agent).

## Continuous Mode (Spec Audit)

Run indefinitely, auditing for new work when all tasks are completed:

```bash
npx tsx run.ts my-project --instruction "Build X" --continuous
```

**Flow:**
1. Work through all failing tasks
2. When all tasks are completed, run spec audit
3. Audit compares implementation against original spec
4. If gaps found: add new tasks and continue
5. Repeat until audit finds no issues

```bash
# Limit audit areas
npx tsx run.ts my-project --instruction "Build X" --continuous --spec-audit-max-areas 5
```

## CLI Reference

```
npx tsx run.ts <project-name> [options]

Options:
  --instruction <text>       Project spec as string
  --instruction-file <f>     Path to spec file
  --prompts-file <f>         JSON file with prompt overrides (non-code domains)
  --sessions <n>             Working sessions (default: unlimited)
  --cpu <cores>              CPU cores (default: 2.0)
  --memory <mb>              Memory MB (default: 4096)
  --timeout <secs>           Timeout seconds (default: 24h)
  --idle-timeout <secs>      Idle timeout seconds (default: 300)
  --repo-url <url>           GitHub repo URL
  --branch <branch>          Git branch (default: main)
  --model <model>            Claude model: opus, sonnet (default: opus)
  --primary-agent <agent>    Primary agent: claude, codex (default: codex)
  --enable-review            Enable review agent ping-pong
  --review-agent <agent>     Review agent: claude, codex (default: codex)
  --codex-model <model>      Codex CLI model for work/review
  --continuous               Run audit when tasks are completed, add new work
  --spec-audit-max-areas <n> Max audit areas (default: 10)
  --terminate                Terminate existing sandbox for this project
```

## Task Dependencies and Scopes

Tasks in `task_list.json` support dependencies and scope-based conflict detection:

```json
{
  "id": "implement-auth",
  "category": "backend",
  "description": "Implement user authentication",
  "steps": ["Create auth middleware", "Add login endpoint"],
  "passes": false,
  "depends_on": ["project-setup"],
  "scope": ["src/auth/", "src/middleware/"]
}
```

- **`depends_on`**: Task IDs that must pass first
- **`scope`**: File/directory paths this task touches (prevents parallel work on overlapping areas)

## Modal Integration

Looper runs inside Modal sandboxes for:
- **Isolation**: Each project runs in its own container
- **Persistence**: Volumes survive sandbox restarts
- **Auto-renewal**: Sandboxes auto-renew before 24h timeout
- **Conflict prevention**: Only one sandbox per project

### Sandbox Image

The sandbox includes:
- Node.js 22, Python 3, Go 1.23, Rust, Java 17
- Playwright + Chromium for browser automation
- Git, ripgrep, build-essential
- Codex CLI pre-installed

### Graceful Shutdown

Press `Ctrl+C` once to finish the current session, twice to force terminate:

```
^C
[Looper] Will stop after the current session finishes. Press Ctrl+C again to force terminate.
```

## Browser Automation

Looper includes Playwright MCP for browser testing:

```typescript
// Automatically available in sandbox
mcpServers: {
  playwright: {
    command: "npx",
    args: ["-y", "@playwright/mcp@latest", "--browser", "chromium", "--headless"],
  },
}
```

Agents can interact with web pages for end-to-end testing.

## Domain-Specific Prompts

Adapt Looper for non-code domains (research, writing, etc.):

```json
{
  "verificationCriteria": "Verify by reading the output and checking for...",
  "reviewChecklist": "1. Check logical coherence\n2. Verify citations...",
  "redFlagPatterns": ["TODO", "TBD", "placeholder"],
  "completionCriteria": "Task is complete when the document..."
}
```

```bash
npx tsx run.ts my-research --instruction "..." --prompts-file prompts.json
```

## Configuration API

```typescript
interface LongRunningHarnessConfig {
  // Required
  projectSpec: string;           // Natural-language project description
  repositoryUrl: string;         // GitHub repo URL

  // Optional
  workingDir?: string;           // Local directory (default: cwd)
  projectName?: string;          // Human-friendly name for prompts
  model?: string;                // "opus", "sonnet", etc.
  branch?: string;               // Git branch (default: "main")
  baseBranch?: string;           // Merge target (default: branch)
  gitToken?: string;             // GitHub token (default: GITHUB_TOKEN env)

  // Agent selection
  primaryAgent?: "claude" | "codex";  // Primary agent (default: codex)
  reviewAgent?: "claude" | "codex";   // Review agent (default: codex)
  enableReviewAgent?: boolean;        // Enable ping-pong review

  // Session limits
  maxPlanningTurns?: number;     // Max turns for planning
  maxWorkingTurns?: number;      // Max turns per working session
  maxReviewIterations?: number;  // Max review rounds (default: 3)
  maxReviewTurns?: number;       // Max turns per review

  // Continuous audit
  continuous?: boolean;          // Run audit when tasks complete
  specAuditMaxAreas?: number;    // Max audit areas (default: 10)
  specAuditModel?: string;       // Model override for audit

  // SDK integration
  useProjectSettings?: boolean;  // Load CLAUDE.md (default: true)
  mcpServers?: Options["mcpServers"];
  sdkOptionsOverride?: Partial<Options>;

  // Domain customization
  prompts?: {
    verificationCriteria?: string;
    reviewChecklist?: string;
    redFlagPatterns?: string[];
    completionCriteria?: string;
  };
}
```

## Development

```bash
# Run tests
pnpm test

# Type check
pnpm lint
```

## Session Independence

Sessions don't share conversation history. All state lives in:
- **Files** — Code, configs, coordination artifacts
- **Git history** — Commit messages, diffs
- **GitHub** — Canonical source of truth

This follows the pattern described in Anthropic's [long-running agents](https://www.anthropic.com/research/building-effective-agents) research.

## License

MIT
