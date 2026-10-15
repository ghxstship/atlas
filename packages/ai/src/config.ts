import { z } from "zod";
import defaults from "../config/models.json" with { type: "json" };
import { AI_FEATURES, type AiFeature } from "./model.ts";

/**
 * Model configuration (Section 4.7). Model identifiers live only in `config/models.json` and the
 * environment; no feature names a model in code. The identifier is recorded on every request row,
 * so the audit log shows which model answered.
 */

const MODEL_ID = /^[a-z0-9][a-z0-9.-]{1,99}$/;

const ModelId = z.string().regex(MODEL_ID, "Model identifiers are lowercase configuration ids.");

const FileSchema = z.object({
  default: ModelId,
  features: z.record(z.string(), ModelId),
  maxTokens: z.record(z.string(), z.number().int().positive()),
});

export interface ModelConfig {
  modelFor(feature: AiFeature): string;
  maxTokensFor(feature: AiFeature): number;
}

export type Environment = Readonly<Record<string, string | undefined>>;

export function envKey(feature: AiFeature): string {
  return `AURORA_MODEL_${feature.toUpperCase()}`;
}

/** Reads the model configuration, letting AURORA_MODEL and AURORA_MODEL_<FEATURE> override the file. */
export function loadModelConfig(
  env: Environment = process.env,
  file: unknown = defaults,
): ModelConfig {
  const parsed = FileSchema.parse(file);
  const all = env["AURORA_MODEL"];
  if (all !== undefined && all !== "") ModelId.parse(all);
  const resolved = new Map<AiFeature, string>();
  for (const feature of AI_FEATURES) {
    const own = env[envKey(feature)];
    const chosen =
      own !== undefined && own !== ""
        ? own
        : all !== undefined && all !== ""
          ? all
          : (parsed.features[feature] ?? parsed.default);
    resolved.set(feature, ModelId.parse(chosen));
  }
  return {
    modelFor: (feature) => resolved.get(feature) ?? parsed.default,
    maxTokensFor: (feature) => parsed.maxTokens[feature] ?? 2048,
  };
}
