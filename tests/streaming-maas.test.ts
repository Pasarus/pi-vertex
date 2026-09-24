import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessageEvent, Context, VertexModelConfig } from "../types.js";

const mocks = vi.hoisted(() => ({
  // @anthropic-ai/vertex-sdk
  anthropicVertex: vi.fn(),
  anthropicStream: vi.fn(),
  // pi-ai openai-completions path
  streamSimpleOpenAICompletions: vi.fn(),
  // auth
  getAuthConfig: vi.fn(),
  resolveLocation: vi.fn(),
  getAccessToken: vi.fn(),
  buildBaseUrl: vi.fn(),
}));

vi.mock("@anthropic-ai/vertex-sdk", () => ({
  AnthropicVertex: mocks.anthropicVertex,
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();
  return {
    ...actual,
    streamSimpleOpenAICompletions: mocks.streamSimpleOpenAICompletions,
  };
});

vi.mock("../auth.js", () => ({
  getAuthConfig: mocks.getAuthConfig,
  resolveLocation: mocks.resolveLocation,
  getAccessToken: mocks.getAccessToken,
  buildBaseUrl: mocks.buildBaseUrl,
}));

// Import AFTER mocks are registered
import { streamMaaS } from "../streaming/maas.js";

const baseContext: Context = { messages: [] };

function makeAnthropicModel(overrides: Partial<VertexModelConfig> = {}): VertexModelConfig {
  return {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    apiId: "claude-sonnet-4-5@20250929",
    publisher: "anthropic",
    endpointType: "maas",
    contextWindow: 200000,
    maxTokens: 64000,
    input: ["text", "image"],
    reasoning: true,
    tools: true,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    region: "global",
    ...overrides,
  };
}

function makeOpenAICompatModel(overrides: Partial<VertexModelConfig> = {}): VertexModelConfig {
  return {
    id: "llama-4-scout",
    name: "Llama 4 Scout",
    apiId: "meta/llama-4-scout-17b-16e-instruct-maas",
    publisher: "meta",
    endpointType: "maas",
    contextWindow: 1310720,
    maxTokens: 32000,
    input: ["text"],
    reasoning: false,
    tools: true,
    cost: { input: 0.25, output: 0.7, cacheRead: 0, cacheWrite: 0 },
    region: "global",
    ...overrides,
  };
}

async function* asyncIter<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("streamMaaS — Anthropic path", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveLocation.mockImplementation((region?: string) => region ?? "us-central1");
    mocks.getAuthConfig.mockReturnValue({ projectId: "test-project", location: "global" });
    mocks.anthropicVertex.mockImplementation(() => ({
      messages: { stream: mocks.anthropicStream },
    }));
  });

  it("emits start → text deltas → done in order on a happy-path stream", async () => {
    mocks.anthropicStream.mockReturnValue(
      asyncIter([
        {
          type: "message_start",
          message: {
            id: "msg_123",
            usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "world" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } },
      ]),
    );

    const events = await collectEvents(streamMaaS(makeAnthropicModel(), baseContext));

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("start");
    expect(types).toContain("text_start");
    expect(types).toContain("text_delta");
    expect(types).toContain("text_end");
    expect(types[types.length - 1]).toBe("done");

    const done = events.find((e) => e.type === "done");
    if (done?.type !== "done") throw new Error("Expected done event");
    expect(done.reason).toBe("stop");
    expect(done.message.usage.input).toBe(10);
    expect(done.message.usage.output).toBe(5);

    // Reconstructed text
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.delta : ""))
      .join("");
    expect(text).toBe("Hello world");
  });

  it("uses regional Claude pricing when the resolved endpoint is non-global", async () => {
    mocks.getAuthConfig.mockReturnValue({ projectId: "test-project", location: "europe-west1" });
    mocks.anthropicStream.mockReturnValue(
      asyncIter([
        {
          type: "message_start",
          message: {
            id: "msg_regional",
            usage: {
              input_tokens: 1_000_000,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 1_000_000 },
        },
      ]),
    );

    const events = await collectEvents(
      streamMaaS(
        makeAnthropicModel({
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          costRegional: { input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: 4.125 },
        }),
        baseContext,
      ),
    );

    const done = events.find((e) => e.type === "done");
    if (done?.type !== "done") throw new Error("Expected done event");
    expect(done.message.usage.cost.input).toBeCloseTo(3.3);
    expect(done.message.usage.cost.output).toBeCloseTo(16.5);
    expect(done.message.usage.cost.total).toBeCloseTo(19.8);
  });

  it("calls stream.end() exactly once across the Anthropic path (no double-end regression)", async () => {
    // Spy on the prototype of the stream returned by the public factory.
    const piAi = await import("@earendil-works/pi-ai");
    const sample = piAi.createAssistantMessageEventStream();
    const proto = Object.getPrototypeOf(sample);
    const endSpy = vi.spyOn(proto, "end");

    mocks.anthropicStream.mockReturnValue(
      asyncIter([
        {
          type: "message_start",
          message: {
            id: "msg_1",
            usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ]),
    );

    // The `sample` stream we created above also goes through the prototype, but we
    // never call .end() on it manually — so any end() call counted here comes from
    // streamMaaS / streamAnthropic. That's exactly what we want to assert.
    await collectEvents(streamMaaS(makeAnthropicModel(), baseContext));

    expect(endSpy).toHaveBeenCalledTimes(1);
    endSpy.mockRestore();
  });

  it("emits a single error event when AnthropicVertex throws synchronously", async () => {
    mocks.anthropicStream.mockImplementation(() => {
      throw new Error("boom");
    });

    const events = await collectEvents(streamMaaS(makeAnthropicModel(), baseContext));

    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect(events.some((e) => e.type === "done")).toBe(false);
    if (last?.type === "error") {
      expect(last.error.errorMessage).toBe("boom");
      expect(last.error.model).toBe("claude-sonnet-4-5");
    }
  });

  it("flips stopReason to toolUse when a tool_use block is present", async () => {
    mocks.anthropicStream.mockReturnValue(
      asyncIter([
        {
          type: "message_start",
          message: {
            id: "msg_t",
            usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tu_1", name: "read" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"path":"/tmp"}' },
        },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
      ]),
    );

    const events = await collectEvents(streamMaaS(makeAnthropicModel(), baseContext));
    const done = events.find((e) => e.type === "done");
    if (done?.type !== "done") throw new Error("Expected done event");
    expect(done.reason).toBe("toolUse");
    const toolCall = done.message.content.find((b: any) => b.type === "toolCall");
    expect(toolCall).toMatchObject({ name: "read", arguments: { path: "/tmp" } });
  });

  it("configures adaptive thinking with display: summarized for Claude 4.6+ models", async () => {
    mocks.anthropicStream.mockReturnValue(
      asyncIter([
        {
          type: "message_start",
          message: { id: "msg_a", usage: { input_tokens: 1 } },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ]),
    );

    const model = makeAnthropicModel({
      id: "claude-opus-4-7",
      apiId: "claude-opus-4-7",
      adaptiveThinking: true,
    });
    await collectEvents(streamMaaS(model, baseContext, { reasoning: "high" }));

    expect(mocks.anthropicStream).toHaveBeenCalledOnce();
    const passedParams = mocks.anthropicStream.mock.calls[0][0];
    expect(passedParams.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(passedParams.output_config).toEqual({ effort: "high" });
  });

  it("configures legacy thinking with budget_tokens and display: summarized for Claude 4.5", async () => {
    mocks.anthropicStream.mockReturnValue(
      asyncIter([
        {
          type: "message_start",
          message: { id: "msg_l", usage: { input_tokens: 1 } },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ]),
    );

    const model = makeAnthropicModel({
      id: "claude-sonnet-4-5",
      apiId: "claude-sonnet-4-5@20250929",
      adaptiveThinking: false,
    });
    await collectEvents(streamMaaS(model, baseContext, { reasoning: "medium" }));

    expect(mocks.anthropicStream).toHaveBeenCalledOnce();
    const passedParams = mocks.anthropicStream.mock.calls[0][0];
    expect(passedParams.thinking).toEqual({
      type: "enabled",
      budget_tokens: 4096,
      display: "summarized",
    });
    expect(passedParams.output_config).toBeUndefined();
  });

  it("preserves empty-text thinking blocks with signatures during tool-call replay", async () => {
    mocks.anthropicStream.mockReturnValue(
      asyncIter([
        {
          type: "message_start",
          message: { id: "msg_r", usage: { input_tokens: 1 } },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ]),
    );

    const contextWithReplay: Context = {
      messages: [
        { role: "user", content: "read file", timestamp: Date.now() },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", thinkingSignature: "validSig123" },
            { type: "toolCall", id: "tc_1", name: "read", arguments: { path: "/test" } },
          ],
        } as any,
        {
          role: "toolResult",
          toolCallId: "tc_1",
          toolName: "read",
          content: [{ type: "text", text: "file content" }],
        } as any,
      ],
    };

    const model = makeAnthropicModel({ id: "claude-opus-4-7", apiId: "claude-opus-4-7" });
    await collectEvents(streamMaaS(model, contextWithReplay));

    expect(mocks.anthropicStream).toHaveBeenCalledOnce();
    const passedMessages = mocks.anthropicStream.mock.calls[0][0].messages;

    const assistantMsg = passedMessages.find((m: any) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.content).toEqual([
      { type: "thinking", thinking: "", signature: "validSig123" },
      { type: "tool_use", id: "tc_1", name: "read", input: { path: "/test" } },
    ]);
  });

  it("parses stringified arguments and preserves multimodal images in tool results", async () => {
    mocks.anthropicStream.mockReturnValue(
      asyncIter([
        {
          type: "message_start",
          message: { id: "msg_mm", usage: { input_tokens: 1 } },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ]),
    );

    const contextWithImage: Context = {
      messages: [
        { role: "user", content: "take screenshot", timestamp: Date.now() },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tc_2",
              name: "screenshot",
              arguments: '{"fullPage":true}' as any,
            },
          ],
        } as any,
        {
          role: "toolResult",
          toolCallId: "tc_2",
          toolName: "screenshot",
          content: [
            { type: "text", text: "captured" },
            { type: "image", mimeType: "image/png", data: "base64png" },
          ],
        } as any,
      ],
    };

    const model = makeAnthropicModel({ id: "claude-opus-4-7", apiId: "claude-opus-4-7" });
    await collectEvents(streamMaaS(model, contextWithImage));

    expect(mocks.anthropicStream).toHaveBeenCalledOnce();
    const passedMessages = mocks.anthropicStream.mock.calls[0][0].messages;

    const assistantMsg = passedMessages.find((m: any) => m.role === "assistant");
    expect(assistantMsg.content[0]).toEqual({
      type: "tool_use",
      id: "tc_2",
      name: "screenshot",
      input: { fullPage: true },
    });

    const userToolResult = passedMessages.find(
      (m: any) => m.role === "user" && m.content[0]?.type === "tool_result",
    );
    expect(userToolResult).toBeDefined();
    expect(userToolResult.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "tc_2",
      content: [
        { type: "text", text: "captured" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "base64png" },
        },
      ],
    });
  });

  it("sanitizes tool schema meta-declarations like $schema for Anthropic", async () => {
    mocks.anthropicStream.mockReturnValue(
      asyncIter([
        {
          type: "message_start",
          message: { id: "msg_s", usage: { input_tokens: 1 } },
        },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
      ]),
    );

    const contextWithTools: Context = {
      messages: [{ role: "user", content: "test", timestamp: Date.now() }],
      tools: [
        {
          name: "custom_tool",
          description: "A tool with schema metadata",
          parameters: {
            $schema: "http://json-schema.org/draft-07/schema#",
            $id: "http://example.com/schema",
            type: "object",
            properties: {
              param1: { type: "string" },
            },
            required: ["param1"],
          },
        },
      ],
    };

    const model = makeAnthropicModel({ id: "claude-opus-4-7", apiId: "claude-opus-4-7" });
    await collectEvents(streamMaaS(model, contextWithTools));

    expect(mocks.anthropicStream).toHaveBeenCalledOnce();
    const passedTools = mocks.anthropicStream.mock.calls[0][0].tools;
    expect(passedTools[0].input_schema).toEqual({
      type: "object",
      properties: {
        param1: { type: "string" },
      },
      required: ["param1"],
    });
    expect(passedTools[0].input_schema).not.toHaveProperty("$schema");
    expect(passedTools[0].input_schema).not.toHaveProperty("$id");
  });
});

describe("streamMaaS — OpenAI-compat path", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveLocation.mockImplementation((region?: string) => region ?? "us-central1");
    mocks.getAuthConfig.mockReturnValue({ projectId: "test-project", location: "global" });
    mocks.getAccessToken.mockResolvedValue("fake-token");
    mocks.buildBaseUrl.mockReturnValue("https://example/v1/projects/p/locations/global");
  });

  it("relays inner OpenAI events and rewrites model id on done", async () => {
    const innerEvents: AssistantMessageEvent[] = [
      {
        type: "start",
        partial: {
          role: "assistant",
          content: [],
          api: "openai-completions",
          provider: "vertex",
          model: "meta/llama-4-scout-17b-16e-instruct-maas",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 0,
        },
      },
      {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi" }],
          api: "openai-completions",
          provider: "vertex",
          model: "meta/llama-4-scout-17b-16e-instruct-maas",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 0,
        },
      },
    ];
    mocks.streamSimpleOpenAICompletions.mockReturnValue(asyncIter(innerEvents));

    const events = await collectEvents(streamMaaS(makeOpenAICompatModel(), baseContext));
    const done = events.find((e) => e.type === "done");
    if (done?.type !== "done") throw new Error("Expected done event");

    // The outer wrapper rewrites .model to the public id (not the apiId).
    expect(done.message.model).toBe("llama-4-scout");
  });
});
