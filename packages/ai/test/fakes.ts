import { loadModelConfig } from "../src/config.ts";
import type { ModelClient, ModelContent, ModelRequest, ModelResponse } from "../src/model.ts";
import type { AuroraContext, AuroraStore, ProposedChange, StoreResult } from "../src/session.ts";

/** A model client that replays scripted responses and records every request. */
export class ScriptedModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private readonly script: (ModelResponse | Error)[];

  constructor(script: (ModelResponse | Error)[]) {
    this.script = [...script];
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const next = this.script.shift();
    if (!next) throw new Error("The scripted model ran out of responses.");
    if (next instanceof Error) throw next;
    return next;
  }
}

export function toolCall(name: string, input: unknown, id = `tu_${name}`): ModelResponse {
  return {
    content: [{ type: "tool_use", id, name, input }],
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 20 },
  };
}

export function toolCalls(
  calls: readonly { name: string; input: unknown; id: string }[],
): ModelResponse {
  return {
    content: calls.map((c): ModelContent => ({
      type: "tool_use",
      id: c.id,
      name: c.name,
      input: c.input,
    })),
    stopReason: "tool_use",
    usage: { inputTokens: 100, outputTokens: 20 },
  };
}

export function text(value: string): ModelResponse {
  return {
    content: [{ type: "text", text: value }],
    stopReason: "end_turn",
    usage: { inputTokens: 50, outputTokens: 10 },
  };
}

export interface StoreLog {
  begun: {
    orgId: string;
    feature: string;
    model: string;
    subject?: { table: string; id: string } | null;
  }[];
  completed: Parameters<AuroraStore["complete"]>[0][];
  proposed: { requestId: string; change: ProposedChange }[];
}

/** An in-memory store standing in for the 0650 RPCs. */
export function memoryStore(
  options: {
    begin?: StoreResult<string>;
    complete?: StoreResult<null>;
    propose?: StoreResult<string>;
  } = {},
): { store: AuroraStore; log: StoreLog } {
  const log: StoreLog = { begun: [], completed: [], proposed: [] };
  let n = 0;
  const store: AuroraStore = {
    async begin(orgId, feature, model, subject) {
      log.begun.push({ orgId, feature, model, ...(subject ? { subject } : {}) });
      return options.begin ?? { ok: true, data: "req-1" };
    },
    async complete(input) {
      log.completed.push(input);
      return options.complete ?? { ok: true, data: null };
    },
    async propose(requestId, change) {
      log.proposed.push({ requestId, change });
      n += 1;
      return options.propose ?? { ok: true, data: `sug-${n}` };
    },
  };
  return { store, log };
}

export function context(client: ModelClient, store: AuroraStore): AuroraContext {
  return { orgId: "org-1", client, store, config: loadModelConfig({}), today: "2026-10-14" };
}
