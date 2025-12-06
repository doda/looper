# Looper

A long-running autonomous coding harness built on the [Claude Agent SDK](https://docs.anthropic.com/en/docs/agents-and-tools/claude-agent-sdk).

Looper manages software projects across multiple independent coding sessions. Each session picks up where the last left off, guided by coordination artifacts stored in git.

## Quick Start

```bash
# Install dependencies
pnpm install

# Run the harness
npx tsx run.ts my-project --instruction "Build a REST API for managing todos"

# Environment variables
export GITHUB_OWNER=your-username    # Used to derive repo URL
export GITHUB_TOKEN=ghp_xxx          # Required for private repos
export ANTHROPIC_API_KEY=sk-xxx      # Required
```

## How It Works

Looper uses a two-agent architecture:

1. **Initializer Agent** — Runs once to scaffold the project and create coordination artifacts
2. **Coding Agent** — Runs in subsequent sessions to implement features one at a time

### Coordination Artifacts

Each Looper-managed project contains these files:

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Project context and guidelines for agents |
| `feature_list.json` | Structured list of features with `passes` flags |
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

Short, phase-specific instructions distinguish initializer from coding sessions:

```typescript
// Initializer
"You are the INITIALIZER agent. Create coordination artifacts..."

// Coding  
"You are a CODING agent. Implement one feature at a time..."
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
  maxInitializerTurns?: number;  // Max turns for initializer (default: 60)
  maxCodingTurns?: number;       // Max turns per coding session
  
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
  --sessions <n>           Coding sessions (default: 10)
  --cpu <cores>            CPU cores (default: 1.0)
  --memory <mb>            Memory MB (default: 2048)
  --timeout <secs>         Timeout seconds (default: 3600)
  --repo-url <url>         GitHub repo URL
  --branch <branch>        Git branch (default: main)
```

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

