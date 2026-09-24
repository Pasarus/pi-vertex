# Fix Thinking Attributes and Tool Calling on Vertex AI

## Context

When using Claude and Gemini models through `@cebarks/pi-vertex`, two critical failures occur in agentic workflows:

1. **Thinking Configuration Failure (Claude 4.7+, Claude 5, dynamically discovered models)**:
   ```
   Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"\"thinking.type.enabled\" is not supported for this model. Use \"thinking.type.adaptive\" and \"output_config.effort\" to control thinking behavior."},"request_id":"req_vrtx_011CfMxxb418LUPvDt6Yrd3y"}
   ```
   - Anthropic deprecated extended thinking (`thinking: { type: "enabled", budget_tokens }`) on Claude 4.6 and completely removed it in Claude 4.7, Claude 4.8, Claude 5 series. Sending `type: "enabled"` is rejected with HTTP 400.
   - In `discovery.ts`, discovered models fall back to `PUBLISHER_DEFAULTS.anthropic`, where `adaptiveThinking` is undefined, causing all dynamically discovered Anthropic models to send legacy `type: "enabled"`.
   - Additionally, on Claude 4.7+ and Claude 5+, `thinking.display` defaults to `"omitted"`, returning empty thinking strings unless `display: "summarized"` is explicitly provided.

2. **Tool Calling Failures (Claude & Gemini)**:
   - **Claude Tool Replay Dropping Thinking**: In multi-turn tool-use conversations, when Claude previously emitted a thinking block followed by a tool call, `streaming/maas.ts` checks `block.thinking?.trim()`. If the thinking text is empty (standard when `display: "omitted"` or on newer models), the thinking block is dropped from the replayed assistant message. Anthropic strictly requires previous assistant messages containing tool calls to retain their exact thinking blocks, rejecting the tool-result turn with HTTP 400 (`thinking blocks cannot be modified`).
   - **Claude Model ID Mismatch**: In `streaming/maas.ts`, `isSameModel` uses exact string comparison `msg.model === model.id`. When models have version tags (e.g. `claude-opus-4-7@20260115` vs `claude-opus-4-7`) or after mid-session model switches, thinking is converted to plain text, breaking tool-call replay.
   - **Claude Redacted Thinking**: Redacted thinking blocks (`block.redacted`) are ignored rather than passed as `{ type: "redacted_thinking", data: block.thinkingSignature }`.
   - **Claude Tool Result Images**: Multimodal tool results (e.g. screenshots) have images silently stripped; Anthropic supports image content blocks inside `tool_result`.
   - **Claude Tool Input Arguments**: Stringified tool arguments from other providers/turns are not parsed to objects before being sent in `tool_use.input`.
   - **Gemini 3 Missing Tool Call IDs**: Gemini 3 requires `id` on both `functionCall` and `functionResponse` parts to correlate calls with responses. Currently `convertToGeminiMessages` omits `id` on both, causing Gemini 3 tool execution to break.
   - **Tool Schema Meta-Declarations**: Tool definitions containing `$schema` or other meta-declarations cause 400 validation errors on both Vertex Anthropic and Vertex Gemini endpoints.

---

## Approach

1. **Adaptive Thinking Resolution**:
   - Provide a centralized helper `isAdaptiveThinking(model)` that checks `model.adaptiveThinking` if explicitly configured, and dynamically inspects model IDs/apiIds (Claude 4.6, 4.7, 4.8, 5, Fable, Mythos $\rightarrow$ adaptive; Claude 4.5 and below $\rightarrow$ legacy budget-based).
   - In `PUBLISHER_DEFAULTS.anthropic`, set `adaptiveThinking: true` as the default for all modern Claude models.
   - In `streaming/maas.ts`, send `{ type: "adaptive", display: "summarized" }` with `output_config: { effort }` for adaptive models. For legacy models, send `{ type: "enabled", budget_tokens: budget, display: "summarized" }`.
   - In `discovery.ts` and `models/index.ts`, normalize versioned model IDs (stripping `@version` suffixes) when looking up static catalog entries.

2. **Hardened Anthropic Tool Calling & Replay**:
   - In `streaming/maas.ts`, preserve thinking blocks whenever `block.thinking?.trim()` OR `block.thinkingSignature` is present.
   - Support `redacted_thinking` blocks via `{ type: "redacted_thinking", data: block.thinkingSignature }`.
   - Strip meta-declarations (`$schema`, `$id`, etc.) from tool schemas and ensure `type: "object"` at root while preserving all valid JSON schema properties.
   - Parse stringified `block.arguments` into objects for `tool_use.input`.
   - Support image blocks in `tool_result` content (`{ type: "image", source: { type: "base64", media_type, data } }`).

3. **Gemini 3 Tool Call Correlation**:
   - In `utils.ts`, implement `requiresToolCallId(modelId)` (true for `gemini-3` and above, as well as cross-provider models).
   - Include `id: toolCallBlock.id` on `functionCall` and `id: toolCallId` on `functionResponse` when `requiresToolCallId` is true.
   - Sanitize Gemini `parametersJsonSchema` by stripping `$schema`, `$id`, and other meta-declarations.

---

## Files to modify

- `streaming/maas.ts`:
  - Adaptive thinking parameter building (`type: "adaptive"`, `display: "summarized"`, `output_config: { effort }`).
  - Thinking block preservation in tool replay (empty text with signature, redacted thinking, robust signature validation).
  - Tool arguments parsing (`typeof block.arguments === "string"` fallback).
  - Tool result image block conversion.
  - Anthropic tool schema sanitization.
- `utils.ts`:
  - `requiresToolCallId(modelId: string)` helper.
  - `convertToGeminiMessages`: add `id` to `functionCall` and `functionResponse` for Gemini 3+.
  - `convertToolsForGemini`: sanitize `$schema` and meta-declarations from `parametersJsonSchema`.
- `discovery.ts`:
  - Set `adaptiveThinking: true` in `PUBLISHER_DEFAULTS.anthropic`.
  - Strip `@version` suffixes when matching discovered models against static model IDs.
- `models/claude.ts`:
  - Ensure all Claude 4.6+ models have `adaptiveThinking: true` and Claude 4.5/below have `adaptiveThinking: false`.
- `models/index.ts`:
  - In `getModelById`, support lookup with `@version` suffix stripped.
- `tests/streaming-maas.test.ts`:
  - Unit tests for adaptive thinking format, legacy thinking format, tool replay with empty-text thinking signatures, and tool result multimodal image preservation.
- `tests/convert-to-gemini.test.ts`:
  - Unit tests for Gemini 3 `functionCall.id` and `functionResponse.id` inclusion, and Gemini 2.5 omission.
- `tests/utils.test.ts`:
  - Unit tests for tool schema sanitization and `requiresToolCallId`.

---

## Reuse

- `retainThoughtSignature` from `utils.ts` for signature propagation.
- `sanitizeText` from `utils.ts` for Unicode sanitization.
- `supportsMultimodalFunctionResponse` from `utils.ts` for multimodal detection.
- Existing `mapAnthropicEffort` from `streaming/maas.ts`.
- Existing `sanitizeToolId` from `streaming/maas.ts`.

---

## Steps

- [x] **Step 1: Adaptive Thinking Helper and Model Definitions**
  - Create `isAdaptiveThinking(model: VertexModelConfig): boolean` in `models/claude.ts` (or `utils.ts`) that accurately classifies Claude models (>= 4.6, 5+, fable, mythos as adaptive; <= 4.5 as legacy).
  - Update `PUBLISHER_DEFAULTS.anthropic` in `discovery.ts` to set `adaptiveThinking: true`.
  - Update `discovery.ts` and `models/index.ts` to normalize `@version` suffixes when mapping discovered models to static metadata.
- [x] **Step 2: Thinking Request Configuration in `streaming/maas.ts`**
  - Send `{ type: "adaptive", display: "summarized" }` and `output_config: { effort }` for adaptive models.
  - Send `{ type: "enabled", budget_tokens: budget, display: "summarized" }` for legacy models.
  - Ensure models with always-on thinking (Claude 5, Fable 5.1) do not emit invalid `{ type: "disabled" }`.
- [x] **Step 3: Fix Tool Call & Thinking Replay in `streaming/maas.ts`**
  - Preserve thinking blocks on assistant turns if `block.thinking?.trim()` OR `block.thinkingSignature` is present.
  - Preserve `redacted_thinking` blocks as `{ type: "redacted_thinking", data: block.thinkingSignature }`.
  - Ensure `input` for `tool_use` is always parsed into an object, even if `block.arguments` is a JSON string.
  - Support image content in `tool_result` user messages.
  - Sanitize `context.tools` by stripping `$schema`, `$id`, and ensuring valid root object schema.
- [x] **Step 4: Fix Gemini 3 Tool Call IDs and Schema Sanitization in `utils.ts`**
  - Add `requiresToolCallId(modelId: string)`.
  - Include `id` in `functionCall` and `functionResponse` for Gemini 3+ models in `convertToGeminiMessages`.
  - Add `sanitizeJsonSchema` to strip `$schema`, `$id`, `$defs`, etc., in `convertToolsForGemini`.
- [x] **Step 5: Tests and Verification**
  - Add tests in `tests/streaming-maas.test.ts` verifying adaptive thinking params, thinking block preservation in tool replay, and tool schema conversion.
  - Add tests in `tests/convert-to-gemini.test.ts` verifying `id` on Gemini 3 functionCall/functionResponse.
  - Run `npm run check` (Biome linting) and `npm run build` (`tsc --noEmit`).
  - Run `npm test` (`vitest run`) and confirm all tests pass.

---

## Verification

1. **Unit Testing (`vitest run`)**:
   - Run `npm test` to verify all existing and new test suites pass (targeting 100+ tests).
   - Verify specific tests:
     - `streaming-maas`: adaptive thinking parameters (`type: "adaptive"`, `display: "summarized"`, `output_config`).
     - `streaming-maas`: legacy extended thinking for Claude 4.5.
     - `streaming-maas`: tool replay with thinking signatures (both non-empty and empty text).
     - `streaming-maas`: multimodal `tool_result` image formatting.
     - `convert-to-gemini`: Gemini 3 tool call IDs on both request and response.
     - `convert-to-gemini`: Gemini tool schema sanitization (removal of `$schema`).
2. **Type Checking & Linting**:
   - `npm run build` (`tsc --noEmit`) to verify zero TypeScript errors.
   - `npm run check` (`biome check .`) to verify style and formatting conformance.
