# OpenCode Telegram Bot — Agent Guide

This file documents how to build, lint, test, and follow code style in this
repository. It is intended for automated coding agents.

Repository: /root/opencode-telegram-bot
Language: TypeScript (Node ESM)

## Commands

Source of truth: package.json scripts and README.md.

### Install

- npm install

### Build / Run

- npm run dev
  - Runs: nodemon --exec ts-node --esm src/index.ts
- npm run build
  - Runs: tsc
- npm run typecheck
  - Runs: tsc --noEmit
- npm start
  - Runs: node dist/index.js

### Lint / Format (Biome)

- npm run lint
  - Runs: biome check .
- npm run format
  - Runs: biome format --write .

### Tests (Vitest)

- npm test (alias: npm run test)
  - Runs: vitest (watch mode by default)
- npm run test:unit
  - Runs: vitest run tests/unit
- npm run test:integration
  - Runs: vitest run tests/integration

#### Single-test guidance

No repo-specific single-test command is documented. Use Vitest CLI patterns
when needed (see Vitest docs), or run a specific file via the Vitest CLI.

### Docker

- npm run docker:build
  - Runs: docker build -t opencode-telegram-bot .
- npm run docker:up
  - Runs: docker-compose up -d
- npm run docker:down
  - Runs: docker-compose down

## Configuration & Runtime Notes

- Required environment variables are listed in .env.example and README.md.
- OpenCode server must be running (README: opencode --server).
- Node.js >= 20 (package.json engines).
- ESM project: "type": "module" in package.json.

## Code Style & Conventions

### TypeScript / Compiler

- target: ES2022
- module: Node16
- moduleResolution: Node16
- strict: true
- noUnusedLocals, noUnusedParameters, noImplicitReturns enabled
- noFallthroughCasesInSwitch enabled
- declaration + source maps enabled
- rootDir: ./src, outDir: ./dist

### Imports

- Use .js extensions for all relative imports in TS files.
  - Example: import { config } from "./config/index.js";
- Use import type for type-only imports.
  - Example: import type { Storage } from "../storage/index.js";
- External imports use package exports (default or named as needed).

### Naming

- Files: kebab-case (session-manager.ts, message-service.ts).
- Classes / interfaces / types: PascalCase.
- Functions / variables: camelCase.
- Env vars: UPPER_SNAKE_CASE.

### Error Handling

- Wrap async operations with try/catch when errors are expected.
- Log errors with context using logger.error(...).
- Return safe fallbacks in non-critical paths (e.g., null/[]), rethrow in
  critical paths when the caller must handle failure.
- For fatal startup errors, exit with process.exit(1).

### Logging

- Use the shared Winston logger from src/utils/logger.ts.
- Prefer logger.info/warn/error with contextual messages.

### Types

- Prefer explicit return types on exported functions and class methods.
- Use discriminated unions for event types.
- Use string literal unions for statuses and roles.

### Formatting

- Biome is the formatter/linter (no biome.json found; defaults apply).
- Keep formatting consistent with existing source files.

## Project Structure (high-level)

- src/bot: Telegram bot setup and command handlers
- src/opencode: OpenCode SDK client wrapper
- src/services: session/message management
- src/storage: storage interface + implementations
- src/utils: shared utilities
- src/config: configuration parsing and validation

## Testing / QA Expectations

- Run typecheck or build after significant changes.
- Use npm run lint before PRs.
- Tests use Vitest; keep new tests in tests/unit or tests/integration.

### Testing Approach

**This is a standalone application, not an OpenCode plugin.** When implementing features:

1. **Understand the Architecture**:
   - The bot runs as a separate Node.js process
   - It connects to OpenCode servers via HTTP API (as a client)
   - It connects to Telegram via Bot API
   - OpenCode must be running separately

2. **Testing Checklist** (test like a user would):
   - Start the bot: `npm run dev`
   - In Telegram: Send `/start` → should get welcome message
   - Send `/help` → should see commands
   - Send a message → should create session and get response
   - Test all commands: `/instances`, `/new`, `/sessions`, `/switch`, `/status`, `/stop`

3. **Common Mistakes to Avoid**:
   - Don't assume OpenCode is a dependency - it's a separate service
   - Don't expect the bot to work without OpenCode server running
   - Remember sessions are per-user and per-instance
   - Event routing depends on correct instanceId matching

4. **Debug Commands**:
   ```bash
   # Check if bot compiles
   npm run typecheck

   # Run with debug logging
   DEBUG_MODE=true LOG_LEVEL=debug npm run dev

   # Test OpenCode connection
   curl http://localhost:3000/session
   ```

## Cursor / Copilot Rules

- No .cursor/rules/, .cursorrules, or .github/copilot-instructions.md found
  in this repository at the time of writing.

## Working Guidelines

- Learn from mistakes: adapt your approach based on errors and feedback.
- Condense context at around 100k tokens to stay within limits.
- Very important: test your implementation from time to time, like a user would do it.

## Security & Git Best Practices

### NEVER commit sensitive files

**CRITICAL**: Before creating any git commit, ensure `.gitignore` exists and includes:
- `.env` (contains API tokens, passwords, secrets)
- `node_modules/` (large, reproducible via package.json)
- `.env.local`, `.env.*.local` (local environment overrides)
- Database files (`.db`, `.sqlite`, etc.)
- Log files (`*.log`)

### Lessons Learned

**Mistake**: Created initial commit including `.env` file with Telegram bot token and user credentials.

**Impact**: Security risk - credentials exposed in git history.

**Resolution**: 
1. Immediately removed entire git history (`rm -rf .git`)
2. Created proper `.gitignore` file
3. Reinitialized repository
4. Made clean commit without sensitive files

**Prevention**:
- Always check `git status` before committing
- Verify `.gitignore` is configured
- Use `git add -A` cautiously - prefer explicit file selection
- Review every file in staging area with `git diff --cached`
