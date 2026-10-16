# Developer & Agent Guide (`AGENTS.md`)

This guide is for AI coding agents and human contributors working on `@pasarus/pi-vertex`. It outlines the repository architecture, critical dispatch pathways, API contracts, testing requirements, and known gotchas.

---

## 1. Project Overview

`@pasarus/pi-vertex` is a Google Vertex AI provider extension for the [Pi Coding Agent](https://pi.dev). It exposes Gemini, Claude, and Model Garden MaaS models (Llama, Mistral, DeepSeek, Qwen, xAI, ZAI, etc.) under a unified provider (`vertex`) with dynamic discovery, streaming, reasoning/thinking, and native tool execution.

### Tech Stack
- **Runtime**: Node.js $\ge$ 22 (ES modules).
- **Core SDKs**:
  - `@google/genai` (^1.42.0) for Vertex Gemini.
  - `@anthropic-ai/vertex-sdk` (^0.14.4) for Claude on Vertex.
  - `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` (*).
  - `google-auth-library` (^11.0.0) for ADC token generation.
- **Linter & Formatter**: Biome (`@biomejs/biome` ^1.9.4).
- **Test Runner**: Vitest (`vitest` ^3.0.0).
- **Type Checker**: TypeScript (`typescript` ^5.7.0, `tsc --noEmit`).

---

## 2. Codebase Structure

```
.
├── auth.ts              # ADC, project ID, location resolution, access token generation
├── config.ts            # Settings loader (~/.pi/agent/settings/pi-vertex.json + env fallbacks)
├── discovery.ts         # Model Garden discovery (list -> probe -> cache)
├── index.ts             # Pi extension entrypoint, registers "vertex" provider and commands
├── types.ts             # Core interfaces (VertexModelConfig, StreamOptions, re-exports)
├── utils.ts             # Unicode sanitization, tool resolution, schema sanitization, signatures
├── models/
│   ├── claude.ts        # Claude static model definitions & isAdaptiveThinking helper
│   ├── gemini.ts        # Gemini static model definitions
│   ├── maas.ts          # Non-Anthropic Model Garden MaaS models
│   └── index.ts         # Static model tables, alias resolution, getModelById
├── streaming/
│   ├── gemini.ts        # Gemini streaming implementation via @google/genai
│   ├── maas.ts          # Anthropic Vertex SDK streaming + OpenAI-compatible MaaS streaming
│   └── index.ts         # streamVertex dispatcher
└── tests/               # 104+ unit tests across auth, models, streaming, utils
```

---

## 3. Core Architectural Mechanisms & Invariants

### A. Context & Tool Extraction (`resolveContextTools` & `resolveSystemPrompt`)
Pi coding agent can pass tools and system instructions in two distinct representations:
1. Direct fields: `context.tools` and `context.systemPrompt`.
2. Transcript system message deltas: `context.messages` containing a leading or mid-conversation `{ role: "system", toolsAdded: [...], toolsRemoved: [...] }`.

> **Critical Invariant**:
> Never rely solely on `context.tools` or `context.systemPrompt`. Always use `resolveContextTools(context)` and `resolveSystemPrompt(context)` from `utils.ts`. If `context.tools` is undefined, `resolveContextTools` extracts active tools from `toolsAdded` on system messages in `context.messages`.

### B. Thinking / Reasoning Modes
- **Adaptive Thinking (Claude 4.6+, 4.7+, 4.8, 5+, Fable, Mythos)**:
  - Must send `{ type: "adaptive", display: "summarized" }` in `params.thinking` and `{ effort }` in `params.output_config`.
  - Sending `{ type: "enabled" }` to Claude 4.7+ or 5+ will trigger an instant HTTP 400 error (`"thinking.type.enabled" is not supported for this model`).
  - `display: "summarized"` must be explicitly included because Claude 4.7+ and Claude 5 default to `display: "omitted"`, which strips the reasoning text from the response.
  - Dynamically discovered Claude models default to `adaptiveThinking: true` in `PUBLISHER_DEFAULTS.anthropic`.
- **Legacy Extended Thinking (Claude 4.5 and below)**:
  - Sends `{ type: "enabled", budget_tokens: budget, display: "summarized" }`.
- **Gemini Thinking**:
  - Gemini 3.x/3.5+ and Gemini 4+ (e.g. `gemini-4-argon`) use `thinkingConfig.thinkingLevel` (`"LOW"`, `"MEDIUM"`, `"HIGH"`).
  - Gemini 2.5 uses `thinkingConfig.thinkingBudget` (token counts).

### C. Multi-Turn Tool Call & History Replay
- **Anthropic Tool Adjacency**:
  - Any assistant turn with `type: "tool_use"` MUST be followed by user turns containing `type: "tool_result"`. Synthetic tool results are generated if tool calls were left unresolved.
  - Tool arguments can arrive from other providers as stringified JSON: always parse `block.arguments` into an object for `tool_use.input`.
  - Thinking blocks on assistant tool calls must be preserved: if `block.thinkingSignature` is present, keep the thinking block even if `block.thinking` is empty. Dropping it causes Anthropic to reject the request with `400: thinking blocks cannot be modified`.
  - Support `redacted_thinking`: replay as `{ type: "redacted_thinking", data: block.thinkingSignature }`.
  - Multimodal tool results: preserve `{ type: "image", source: { type: "base64", media_type, data } }` in `tool_result` content.
- **Gemini 3+ / 4+ Tool Call Correlation**:
  - Gemini 3+ and Gemini 4+ require `id` on both `functionCall` and `functionResponse` parts (`requiresToolCallId(modelId)`).
  - For Gemini 2.5, `id` is omitted.
- **JSON Schema Sanitization**:
  - Both Anthropic and Gemini Vertex APIs reject schema meta-declarations like `$schema`, `$id`, `$anchor`, `$defs`, etc.
  - Always run tool parameter schemas through `sanitizeJsonSchema()` before sending them to Vertex endpoints.

### D. Model Alias Resolution
`getModelById` in `models/index.ts` normalizes model lookups:
- Strips `@version` tags (e.g. `claude-opus-4-7@20260115` $\to$ `claude-opus-4-7`).
- Resolves common aliases: `opus-5.5` $\to$ `claude-opus-5-5`, `gemini-flash` $\to$ `gemini-3.5-flash`, `gemini-pro` $\to$ `gemini-2.5-pro`, etc.

---

## 4. Development & Verification Workflow

Always verify changes using the repository's test and lint scripts:

```bash
# 1. Type check
npm run build      # tsc --noEmit

# 2. Lint and format check
npm run check      # biome check .

# 3. Format fix (if Biome finds whitespace/formatting issues)
npm run check:fix  # biome check . --write

# 4. Run test suite
npm test           # vitest run
```

### Local Testing inside Pi
To install and test local modifications inside the Pi harness:

```bash
# Install local working copy
pi install /home/sam/pi-vertex

# Clear model discovery cache to force re-probing
rm -f ~/.pi/agent/cache/pi-vertex-models.json

# Test in single-shot mode
pi --provider vertex --model gemini-3.5-flash -p "list your tools"
pi --provider vertex --model claude-opus-5-5 -p "list your tools"
```

---

## 5. Coding Conventions

- **Pure ES Modules**: Always use explicit `.js` extensions for local module imports (`import { ... } from "./utils.js"`).
- **Hermetic Unit Tests**: When testing auth fallback or environment variables, keep tests hermetic by mocking `process.env` and resolving locations deterministically.
- **Strict Error Handling**: Pass streaming errors through `stream.push({ type: "error", error })` rather than unhandled promise rejections.
- **Never Halve `maxTokens`**: Models on Vertex expect their configured token limits directly; do not artificially truncate `maxTokens`.
