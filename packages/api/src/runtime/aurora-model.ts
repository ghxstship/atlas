import type { ModelClient } from "@xos/ai";
import { auroraHandlers } from "../handlers/parts/aurora.ts";
import { MODULE_HANDLERS } from "../handlers/index.generated.ts";
import type { AnyModuleHandlers } from "./handler.ts";

/**
 * Every module handler set with Aurora's operations bound to another model client, for a host
 * that must not reach the model provider: Atlas's end-to-end fixture model (finding A24-007). The
 * host decides when this is allowed; production never calls it. Only the Settings set changes, and
 * only its Aurora operations, so every other handler is the one production serves.
 */
export function handlersWithAuroraModel(
  model: () => ModelClient | Promise<ModelClient>,
): readonly AnyModuleHandlers[] {
  const aurora = auroraHandlers({ model });
  return MODULE_HANDLERS.map((set) =>
    set.module === "Settings"
      ? { module: set.module, handlers: { ...set.handlers, ...aurora } }
      : set,
  );
}
