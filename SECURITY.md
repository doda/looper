# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Looper, please report it responsibly:

1. **Do not** open a public issue
2. Email the maintainers directly or use GitHub's private vulnerability reporting feature
3. Include detailed steps to reproduce the vulnerability
4. Allow reasonable time for a fix before public disclosure

## Security Considerations

### Credentials

Looper handles several types of credentials:

- **GitHub tokens** (`GITHUB_TOKEN`) — Used for repository access
- **Anthropic API keys** (`ANTHROPIC_API_KEY`) — Used for Claude API access
- **Claude Code OAuth** (`.claude-code-credentials.json`) — OAuth tokens for Claude Code
- **Codex credentials** (`~/.codex/auth.json`) — OpenAI Codex authentication

**Best practices:**

- Never commit credentials to version control
- The `.claude-code-credentials.json` file is gitignored by default
- Use environment variables for API keys
- Credentials are passed to Modal sandboxes via encrypted secrets

### Sandbox Isolation

Looper runs agent sessions inside Modal sandboxes, providing:

- Isolated execution environments
- No direct access to host filesystem (except mounted volumes)
- Network isolation configurable via Modal

### Agent Permissions

When running with `bypassPermissions`, agents have full access within their sandbox. This is intentional for autonomous operation but means:

- Agents can execute arbitrary commands
- Agents can modify any files in the workspace
- Only use with trusted project specs

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x.x   | :white_check_mark: |

Security updates will be applied to the latest version.

