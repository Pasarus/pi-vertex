import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../types.js";
import {
  calculateCost,
  convertTools,
  convertToolsForGemini,
  mapStopReason,
  requiresToolCallId,
  retainThoughtSignature,
  sanitizeJsonSchema,
  sanitizeText,
  usesGeminiThinkingLevel,
} from "../utils.js";

describe("sanitizeText", () => {
  it("passes clean text through", () => {
    expect(sanitizeText("hello world")).toBe("hello world");
  });

  it("preserves valid surrogate pairs", () => {
    expect(sanitizeText("hello 😀 world")).toBe("hello 😀 world");
  });

  it("removes lone surrogates", () => {
    expect(sanitizeText("\uD800")).toBe("");
    expect(sanitizeText("\uDFFF")).toBe("");
  });

  it("removes unpaired surrogates inside text", () => {
    expect(sanitizeText("a\uD800b\uDFFFc")).toBe("abc");
  });
});

describe("retainThoughtSignature", () => {
  it("returns incoming when present", () => {
    expect(retainThoughtSignature("old", "new")).toBe("new");
  });

  it("returns existing when incoming is undefined", () => {
    expect(retainThoughtSignature("old", undefined)).toBe("old");
  });

  it("returns existing when incoming is empty string", () => {
    expect(retainThoughtSignature("old", "")).toBe("old");
  });

  it("returns undefined when both are absent", () => {
    expect(retainThoughtSignature(undefined, undefined)).toBeUndefined();
  });
});

describe("mapStopReason", () => {
  it("maps stop/end_turn to stop", () => {
    expect(mapStopReason("stop")).toBe("stop");
    expect(mapStopReason("end_turn")).toBe("stop");
  });

  it("maps length/max_tokens to length", () => {
    expect(mapStopReason("length")).toBe("length");
    expect(mapStopReason("max_tokens")).toBe("length");
  });

  it("maps tool_calls/tool_use to toolUse", () => {
    expect(mapStopReason("tool_calls")).toBe("toolUse");
    expect(mapStopReason("tool_use")).toBe("toolUse");
  });

  it("defaults unknown reasons to error", () => {
    expect(mapStopReason("content_filter")).toBe("error");
    expect(mapStopReason("")).toBe("error");
  });
});

describe("calculateCost", () => {
  it("computes cost per-million-token pricing", () => {
    const usage: AssistantMessage["usage"] = {
      input: 1_000_000,
      output: 2_000_000,
      cacheRead: 500_000,
      cacheWrite: 100_000,
      totalTokens: 3_600_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    calculateCost(3.0, 15.0, 0.3, 3.75, usage);

    expect(usage.cost.input).toBe(3.0);
    expect(usage.cost.output).toBe(30.0);
    expect(usage.cost.cacheRead).toBe(0.15);
    expect(usage.cost.cacheWrite).toBe(0.375);
    expect(usage.cost.total).toBe(33.525);
  });

  it("handles zero usage", () => {
    const usage: AssistantMessage["usage"] = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };

    calculateCost(5.0, 25.0, 0.5, 6.25, usage);

    expect(usage.cost.total).toBe(0);
  });
});

describe("convertTools", () => {
  it("converts tools to OpenAI format", () => {
    const tools = [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
      },
    ];

    const result = convertTools(tools);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: "function",
      function: {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
      },
    });
  });
});

describe("convertToolsForGemini", () => {
  it("returns undefined for empty tool array", () => {
    expect(convertToolsForGemini([])).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(convertToolsForGemini(undefined as any)).toBeUndefined();
  });

  it("strips $schema and meta-declarations from parametersJsonSchema", () => {
    const tools = [
      {
        name: "test",
        description: "Test tool",
        parameters: {
          $schema: "http://json-schema.org/draft-07/schema#",
          $id: "schema-id",
          type: "object",
          properties: {
            arg: { type: "string" },
          },
        },
      },
    ];

    const result = convertToolsForGemini(tools);
    expect(result?.[0].functionDeclarations[0].parametersJsonSchema).toEqual({
      type: "object",
      properties: {
        arg: { type: "string" },
      },
    });
  });
});

describe("sanitizeJsonSchema", () => {
  it("recursively removes meta-declarations", () => {
    const schema = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "my-id",
      $comment: "a comment",
      type: "object",
      properties: {
        nested: {
          $defs: {},
          type: "string",
        },
      },
    };
    expect(sanitizeJsonSchema(schema)).toEqual({
      type: "object",
      properties: {
        nested: {
          type: "string",
        },
      },
    });
  });
});

describe("requiresToolCallId", () => {
  it("returns true for Gemini 3+ and Gemini 4+ models", () => {
    expect(requiresToolCallId("gemini-3-pro")).toBe(true);
    expect(requiresToolCallId("gemini-3.5-flash")).toBe(true);
    expect(requiresToolCallId("gemini-4-argon")).toBe(true);
  });

  it("returns false for Gemini 2.5 models", () => {
    expect(requiresToolCallId("gemini-2.5-pro")).toBe(false);
    expect(requiresToolCallId("gemini-2.5-flash")).toBe(false);
  });

  it("returns true for Claude and GPT-OSS models", () => {
    expect(requiresToolCallId("claude-opus-4-7")).toBe(true);
    expect(requiresToolCallId("gpt-oss-120b")).toBe(true);
  });
});

describe("usesGeminiThinkingLevel", () => {
  it("returns true for Gemini 3+ and Gemini 4+ models", () => {
    expect(usesGeminiThinkingLevel("gemini-3-flash-preview")).toBe(true);
    expect(usesGeminiThinkingLevel("gemini-3.1-pro-preview")).toBe(true);
    expect(usesGeminiThinkingLevel("gemini-3.5-flash")).toBe(true);
    expect(usesGeminiThinkingLevel("gemini-3.8-flash")).toBe(true);
    expect(usesGeminiThinkingLevel("gemini-4-argon")).toBe(true);
  });

  it("returns false for Gemini 2.5 and 2.0 models", () => {
    expect(usesGeminiThinkingLevel("gemini-2.5-pro")).toBe(false);
    expect(usesGeminiThinkingLevel("gemini-2.5-flash")).toBe(false);
    expect(usesGeminiThinkingLevel("gemini-2.0-flash")).toBe(false);
  });
});
