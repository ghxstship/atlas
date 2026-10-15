import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type {
  ModelClient,
  ModelContent,
  ModelMessage,
  ModelRequest,
  ModelResponse,
} from "./model.ts";

/**
 * The production model client: Anthropic's Claude models through the Anthropic API (Section 4.7).
 * The SDK reads the API key from the ANTHROPIC_API_KEY environment variable on the server; this
 * module never reads, stores or logs it, and it never reaches a browser bundle. Under Anthropic's
 * commercial terms, API data is not used for training. Import this module only on the server.
 */

function toBlock(content: ModelContent): ContentBlockParam {
  switch (content.type) {
    case "text":
      return { type: "text", text: content.text };
    case "tool_use":
      return { type: "tool_use", id: content.id, name: content.name, input: content.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: content.toolUseId,
        content: content.content,
        ...(content.isError ? { is_error: true } : {}),
      };
    case "document":
      if (content.mediaType === "application/pdf") {
        return {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: content.data },
        };
      }
      if (content.mediaType === "text/plain") {
        return {
          type: "document",
          source: { type: "text", media_type: "text/plain", data: content.data },
        };
      }
      return {
        type: "image",
        source: { type: "base64", media_type: content.mediaType, data: content.data },
      };
  }
}

function toMessage(message: ModelMessage): MessageParam {
  return { role: message.role, content: message.content.map(toBlock) };
}

function stopReason(reason: string | null): ModelResponse["stopReason"] {
  if (
    reason === "end_turn" ||
    reason === "tool_use" ||
    reason === "max_tokens" ||
    reason === "refusal"
  ) {
    return reason;
  }
  return "other";
}

export class AnthropicModelClient implements ModelClient {
  private readonly sdk: Anthropic;

  constructor(options: { readonly timeoutMs?: number; readonly maxRetries?: number } = {}) {
    this.sdk = new Anthropic({
      timeout: options.timeoutMs ?? 60_000,
      maxRetries: options.maxRetries ?? 2,
    });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const tools: Tool[] | undefined = request.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { type: "object", ...t.inputSchema } as Tool["input_schema"],
    }));
    const message = await this.sdk.messages.create({
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: request.messages.map(toMessage),
      ...(tools ? { tools } : {}),
      ...(request.toolChoice ? { tool_choice: request.toolChoice } : {}),
    });
    const content: ModelContent[] = [];
    for (const block of message.content) {
      if (block.type === "text") content.push({ type: "text", text: block.text });
      else if (block.type === "tool_use") {
        content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      }
    }
    return {
      content,
      stopReason: stopReason(message.stop_reason),
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    };
  }
}

/** True when the server has an Anthropic API key configured. Reads presence only, never the value. */
export function anthropicConfigured(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const key = env["ANTHROPIC_API_KEY"];
  return typeof key === "string" && key.length > 0;
}
