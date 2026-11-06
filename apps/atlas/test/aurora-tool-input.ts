import type { ModelResponse } from "@xos/ai";

/** The input of a model response's tool call, for a fixture's test. */
export function toolInput(response: ModelResponse): unknown {
  const use = response.content.find((c) => c.type === "tool_use");
  return use?.type === "tool_use" ? use.input : null;
}
