# Looper

A long-running autonomous harness built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-and-tools/claude-agent-sdk).

Looper manages projects across multiple independent working sessions. Each session picks up where the last left off, guided by coordination artifacts stored in git.

## Quick Start

```bash
# Install dependencies
pnpm install

# Run the harness
npx tsx run.ts my-project --instruction "Build a REST API for managing todos"

# Environment variables
export GITHUB_OWNER=your-username    # Used to derive repo URL
export GITHUB_TOKEN=ghp_xxx          # Required for private repos

# Authentication (choose one):
export ANTHROPIC_API_KEY=sk-xxx      # Option 1: API key
# OR use OAuth credentials (Option 2):
# Place .claude-code-credentials.json in the repo root, or use --claude-oauth-file
```

## How It Works

Looper uses a two-agent architecture:

1. **Planning Agent** — Runs once to create the task list and coordination artifacts
2. **Working Agent** — Runs in subsequent sessions to implement tasks one at a time

### Coordination Artifacts

Each Looper-managed project contains these files:

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Project context and guidelines for agents |
| `task_list.json` | Structured list of tasks with `passes` flags |
| `claude-progress.txt` | Running log of work and decisions |
| `init.sh` | Idempotent script to boot environment and run smoke tests |

### Session Independence

Sessions don't share conversation history. All state lives in:
- **Files** — Code, configs, coordination artifacts
- **Git history** — Commit messages, diffs, branches
- **GitHub** — Canonical source of truth

This follows the pattern described in Anthropic's [long-running agents](https://www.anthropic.com/research/building-effective-agents) research.

## System Prompt Strategy

Looper uses a layered approach to guide Claude:

### 1. Claude Code Preset (Base)

```typescript
systemPrompt: {
  type: "preset",
  preset: "claude_code",
  append: "...",
}
```

The `claude_code` preset provides:
- Tool usage instructions (file ops, Bash, web tools)
- Code style and formatting guidelines
- Security and safety instructions
- Environment context

### 2. CLAUDE.md Files (Persistent Context)

Looper reads `CLAUDE.md` from both:
- **Looper repo** — Shared harness philosophy and guidelines
- **Target project** — Project-specific architecture, standards, and commands

This is enabled via:
```typescript
settingSources: ["project"]
```

### 3. System Prompt Append (Phase-Specific)

Short, phase-specific instructions distinguish planning from working sessions:

```typescript
// Planning
"You are the PLANNING agent. Create coordination artifacts..."

// Working
"You are a WORKING agent. Implement one task at a time..."
```

### Why This Layered Approach?

| Layer | Persistence | Scope | Best For |
|-------|-------------|-------|----------|
| Claude Code preset | Built-in | All sessions | Tools, safety, formatting |
| CLAUDE.md | Per-project | All sessions in project | Architecture, standards, commands |
| Append | Session only | Single session | Phase-specific behavior |

## Configuration

### LongRunningHarnessConfig

```typescript
interface LongRunningHarnessConfig {
  // Required
  projectSpec: string;           // Natural-language project description
  repositoryUrl: string;         // GitHub repo URL (canonical source)

  // Optional
  workingDir?: string;           // Local directory (default: cwd)
  projectName?: string;          // Human-friendly name for prompts
  model?: string;                // "opus", "sonnet", etc.
  branch?: string;               // Git branch (default: "main")
  gitToken?: string;             // GitHub token (default: GITHUB_TOKEN env)
  
  // Session limits
  maxPlanningTurns?: number;     // Max turns for planning (default: 60)
  maxWorkingTurns?: number;      // Max turns per working session
  
  // SDK integration
  useProjectSettings?: boolean;  // Load CLAUDE.md (default: true)
  mcpServers?: Options["mcpServers"];
  sdkOptionsOverride?: Partial<Options>;
}
```

### CLI Options

```
npx tsx run.ts <project-name> [options]

Options:
  --instruction <text>     Project spec as string
  --instruction-file <f>   Path to spec file
  --sessions <n>           Working sessions (default: 10)
  --cpu <cores>            CPU cores (default: 1.0)
  --memory <mb>            Memory MB (default: 2048)
  --timeout <secs>         Timeout seconds (default: 3600)
  --repo-url <url>         GitHub repo URL
  --branch <branch>        Git branch (default: main)
  --claude-oauth-file <f>  Path to Claude Code OAuth credentials JSON
                           (default: ./.claude-code-credentials.json)
```

## Authentication

Looper supports two authentication methods for the Claude Agent SDK:

1. **API Key** (traditional): Set `ANTHROPIC_API_KEY` environment variable
2. **OAuth Credentials** (recommended for Claude Code): Place `.claude-code-credentials.json` in the repo root, or use `--claude-oauth-file` flag

The OAuth credentials file should contain JSON in this format:
```json
{
  "claudeAiOauth": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": 1234567890,
    "scopes": ["user:inference", "user:profile", "user:sessions:claude_code"],
    "subscriptionType": "pro",
    "rateLimitTier": "default_claude_ai"
  }
}
```

When OAuth credentials are provided, they take precedence over `ANTHROPIC_API_KEY`. The credentials are securely injected into the Modal sandbox and written to `/home/looper/.config/claude/.credentials.json` where the SDK can automatically discover them (via `CLAUDE_CONFIG_DIR` environment variable).

**Note:** The `.claude-code-credentials.json` file is automatically added to `.gitignore` to prevent accidental commits.

## Modal Integration

Looper runs inside [Modal](https://modal.com) sandboxes for isolation and reproducibility:

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
│  │  run.ts (harness mode)            │  │
│  │  - Clones repo from GitHub        │  │
│  │  - Runs LongRunningHarness        │  │
│  │  - Pushes commits back            │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

## Development

```bash
# Run tests
pnpm test

# Type check
pnpm lint
```

## License

MIT

