# AGENTS.md

This document provides guidance for AI coding agents working in this repository.

## CRITICAL: Mastra Skill Required

**BEFORE doing ANYTHING with Mastra code or answering Mastra questions, load the Mastra skill FIRST.**

See [Mastra Skills section](#mastra-skills) for loading instructions.

## Project Overview

This is a **Mastra** project written in TypeScript - an AI-powered code review agent that reviews GitHub pull requests using Ollama LLMs with full repository context access.

## Commands

### Installation

```bash
npm install
```

### Development

```bash
npm run dev          # Start with auto-reload on port 4111
npm run start        # Production mode (no reload)
```

### Build

```bash
npm run build        # TypeScript compilation to ./dist
```

### Testing

```bash
npm run test         # Run main test suite (src/test.ts)
npm run test:tools   # Test tools individually (src/test-tools.ts)
npm run eval         # Run evaluation system (src/evals/code-review-eval.ts)
```

**Running a single test:** This project uses tsx for running TypeScript directly. To run a specific test file:

```bash
npx tsx src/path/to/test-file.ts
```

## Code Style Guidelines

### Imports

- **Load environment variables FIRST** before any other imports:
  ```typescript
  import dotenv from "dotenv";
  dotenv.config();
  // Then other imports...
  ```

- Use ES module syntax with `.js` extensions for local imports:
  ```typescript
  import { something } from "./module.js";  // Note: .js even for .ts files
  ```

- Group imports logically: external packages first, then local modules

- Use `verbatimModuleSyntax: true` in tsconfig - import types explicitly:
  ```typescript
  import { z } from "zod";
  import type { SomeType } from "./types.js";
  ```

### Formatting

- Use double quotes for strings (consistent with Prettier defaults)
- No trailing commas in function parameter lists
- Semicolons are required
- 2-space indentation

### Types and Schemas

- Use **Zod** for all runtime validation and schema definitions
- Define schemas at the top of files before usage:
  ```typescript
  const PRFileSchema = z.object({
    filename: z.string(),
    status: z.enum(["added", "modified", "deleted", "renamed"]),
    additions: z.number(),
  });
  ```

- Use `.describe()` for schema field documentation:
  ```typescript
  owner: z.string().describe("Repository owner (username or organization)")
  ```

- Export schemas for reuse: `export { PRFileSchema };`

### Naming Conventions

- **Files:** kebab-case (e.g., `github-tools.ts`, `pr-review-workflow.ts`)
- **Variables/Functions:** camelCase (e.g., `getPullRequestFiles`, `prTitle`)
- **Constants:** UPPER_SNAKE_CASE for env vars, camelCase for others
- **Schemas:** PascalCase with `Schema` suffix (e.g., `WebhookPayloadSchema`)
- **Tools/Agents:** camelCase for exports (e.g., `codeReviewAgent`, `getPullRequestFiles`)
- **Tool IDs:** kebab-case (e.g., `"get-pull-request-files"`)

### Error Handling

- Always check for required environment variables at function start:
  ```typescript
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is required");
  }
  ```

- Use try/catch for async operations, return structured error responses:
  ```typescript
  try {
    // async operation
    return { success: true, data };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return { success: false, message: `Failed: ${errorMessage}` };
  }
  ```

- Log errors with context: `console.error("[Context] ERROR:", error);`

### Logging

- Use bracketed context prefixes for log messages:
  ```typescript
  console.log("[fetchPRContext] Fetching PR files...");
  console.error("[performReview] ERROR during agent.generateLegacy():", error);
  ```

### Mastra-Specific Patterns

- **Tools:** Use `createTool` from `@mastra/core/tools` with Zod schemas:
  ```typescript
  export const myTool = createTool({
    id: "my-tool",
    description: "Tool description",
    inputSchema: z.object({ ... }),
    outputSchema: z.object({ ... }),
    execute: async (inputData) => { ... },
  });
  ```

- **Agents:** Use `Agent` from `@mastra/core/agent`:
  ```typescript
  export const myAgent = new Agent({
    id: "my-agent",
    name: "My Agent",
    instructions: "...",
    model: getModel(),
    tools: { tool1, tool2 },
  });
  ```

- **Workflows:** Use `createWorkflow` and `createStep` from `@mastra/core/workflows`:
  ```typescript
  export const myWorkflow = createWorkflow({
    id: "my-workflow",
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
  })
    .then(step1)
    .then(step2)
    .commit();
  ```

- **Ollama models:** Use `generateLegacy()` for AI SDK v4 compatibility:
  ```typescript
  const result = await agent.generateLegacy([{ role: "user", content: prompt }]);
  ```

### Comments

- Avoid unnecessary comments - code should be self-documenting
- Add comments for:
  - Environment variable loading (must be first)
  - Non-obvious business logic
  - Workarounds or compatibility notes
  - Export grouping headers (e.g., `// GitHub API tools`)

## Project Structure

| Path | Description |
|------|-------------|
| `src/index.ts` | Express webhook server entry point |
| `src/mastra/index.ts` | Mastra configuration and exports |
| `src/mastra/agents/` | Agent definitions |
| `src/mastra/tools/` | Tool definitions (github, file, telegram) |
| `src/mastra/workflows/` | Multi-step workflow definitions |
| `src/evals/` | Evaluation system for review quality |

## Environment Variables

Required:
- `GITHUB_TOKEN` - GitHub PAT with `repo` scope
- `OLLAMA_BASE_URL` - Ollama server URL (default: `http://localhost:11434`)
- `OLLAMA_MODEL` - Model name (default: `qwen3:8b`)

Optional:
- `GITHUB_WEBHOOK_SECRET` - Webhook signature verification
- `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` - Notifications
- `PORT` - Server port (default: `4111`)

## Mastra Skills

1. **Load the Mastra skill FIRST** - Use `/mastra` command or Skill tool
2. **Never rely on cached knowledge** - Mastra APIs change frequently
3. **Always verify against current docs** - The skill provides up-to-date documentation

## Resources

- [Mastra Documentation](https://mastra.ai/llms.txt)
- [Mastra .well-known skills discovery](https://mastra.ai/.well-known/skills/index.json)
