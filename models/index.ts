/**
 * Model definitions and discovery integration.
 *
 * Static model tables provide authoritative metadata (pricing, context windows,
 * capabilities). Dynamic discovery determines which models are actually available
 * in the user's GCP project via countTokens probing.
 */

import type { DiscoveryOptions } from "../discovery.js";
import { buildModelConfigs, discoverAvailableModels } from "../discovery.js";
import type { VertexModelConfig } from "../types.js";
import { CLAUDE_MODELS, isAdaptiveThinking } from "./claude.js";
import { GEMINI_MODELS } from "./gemini.js";
import { MAAS_MODELS } from "./maas.js";

/** All statically defined models (metadata enrichment source). */
export const STATIC_MODELS: VertexModelConfig[] = [
  ...GEMINI_MODELS,
  ...CLAUDE_MODELS,
  ...MAAS_MODELS,
].sort((a, b) => a.id.localeCompare(b.id));

/**
 * Get all available models: discover what's accessible in the GCP project,
 * enrich with static metadata where available, use publisher defaults otherwise.
 */
export async function getAllModels(
  options?: DiscoveryOptions,
): Promise<{ models: VertexModelConfig[]; fromCache: boolean; count: number }> {
  const { available, fromCache } = await discoverAvailableModels(options);

  if (available.length === 0) {
    // Discovery disabled or failed — fall back to static models
    return { models: STATIC_MODELS, fromCache: false, count: STATIC_MODELS.length };
  }

  const models = buildModelConfigs(available, STATIC_MODELS);
  return { models, fromCache, count: models.length };
}

const MODEL_ALIASES: Record<string, string> = {
  "gemini-flash": "gemini-3.5-flash",
  "gemini-pro": "gemini-2.5-pro",
  "opus-5.5": "claude-opus-5-5",
  "claude-opus-5.5": "claude-opus-5-5",
  "opus-5": "claude-opus-5",
  "sonnet-5": "claude-sonnet-5",
  "opus-4.8": "claude-opus-4-8",
  "opus-4.7": "claude-opus-4-7",
  "opus-4.6": "claude-opus-4-6",
  "sonnet-4.6": "claude-sonnet-4-6",
  "sonnet-4.5": "claude-sonnet-4-5",
};

export function getModelById(id: string): VertexModelConfig | undefined {
  const resolvedId = MODEL_ALIASES[id] ?? id;
  const baseId = resolvedId.split("@")[0];
  const normalizedBaseId = baseId.replace(/\./g, "-");
  return STATIC_MODELS.find(
    (m) =>
      m.id === id ||
      m.id === resolvedId ||
      m.id === baseId ||
      m.id === normalizedBaseId ||
      m.apiId === id ||
      m.apiId === resolvedId,
  );
}

export function getModelsByEndpointType(type: "gemini" | "maas"): VertexModelConfig[] {
  return STATIC_MODELS.filter((m) => m.endpointType === type);
}

export { GEMINI_MODELS, CLAUDE_MODELS, MAAS_MODELS, isAdaptiveThinking };
