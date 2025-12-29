# Looper Development

Development guidelines for working on Looper itself.

## Commands

- **Run harness:** `npx tsx run.ts <project-name> --instruction "..."`
- **Run tests:** `pnpm test`
- **Type check:** `pnpm lint`

## Code Style

- TypeScript strict mode
- Prefer async/await over callbacks
- Keep harness code simple and auditable
- Test with `pnpm test` before committing

## Avoid patterns inconsistent with the codebase:

- **Extra comments** — Don't add comments a human wouldn't write or that clash with file style
- **Defensive overkill** — Skip unnecessary try/catch or null checks in trusted internal paths
- **Type escapes** — Don't cast to `any` to silence errors; fix the types properly
- **Over-abstraction** — Don't create helpers or utilities for one-time operations
- **Verbose naming** — Match the naming conventions already in the file
