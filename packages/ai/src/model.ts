/**
 * The model boundary. Every Aurora feature talks to a `ModelClient`; production wires the Anthropic
 * client (`@xos/ai/anthropic`), unit tests wire a scripted client, and evals wire the Anthropic
 * client against fixed test sets. Nothing outside `anthropic.ts` knows the provider's wire format.
 */

/** The Aurora features, matching the database enum `app.ai_feature` (migration 0650). */
export const AI_FEATURES = [
  "assistant",
  "plain_language",
  "extraction",
  "drafting",
  "summaries",
  "mapping",
] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export function isAiFeature(value: string): value is AiFeature {
  return (AI_FEATURES as readonly string[]).includes(value);
}

export interface TextContent {
  readonly type: "text";
  readonly text: string;
}

export interface ToolUseContent {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ToolResultContent {
  readonly type: "tool_result";
  readonly toolUseId: string;
  readonly content: string;
  readonly isError?: boolean;
}

/** A document the person chose to extract: PDF or image bytes in base64, or plain text. */
export interface DocumentContent {
  readonly type: "document";
  readonly mediaType: "application/pdf" | "text/plain" | "image/png" | "image/jpeg" | "image/webp";
  readonly data: string;
}

export type ModelContent = TextContent | ToolUseContent | ToolResultContent | DocumentContent;

export interface ModelMessage {
  readonly role: "user" | "assistant";
  readonly content: readonly ModelContent[];
}

/** A tool the model may call. `inputSchema` is a JSON Schema object. */
export interface ModelTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export type ToolChoice =
  { readonly type: "auto" } | { readonly type: "tool"; readonly name: string };

export interface ModelRequest {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ModelTool[];
  readonly toolChoice?: ToolChoice;
  readonly maxTokens: number;
}

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface ModelResponse {
  readonly content: readonly ModelContent[];
  readonly stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";
  readonly usage: ModelUsage;
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/** Adds two usage counts, so multi-turn features meter every call. */
export function addUsage(a: ModelUsage, b: ModelUsage): ModelUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

export const NO_USAGE: ModelUsage = { inputTokens: 0, outputTokens: 0 };

/** The first call of the named tool in a response, or null. */
export function findToolUse(response: ModelResponse, name: string): ToolUseContent | null {
  for (const block of response.content) {
    if (block.type === "tool_use" && block.name === name) return block;
  }
  return null;
}

/** Text blocks of a response joined, for logs. */
export function responseText(response: ModelResponse): string {
  return response.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "tool_use") return `${block.name} ${JSON.stringify(block.input)}`;
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}
