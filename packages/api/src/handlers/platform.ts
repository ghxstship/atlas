/**
 * Platform handlers. Add one entry per operationId of the Platform module; operations left out stay
 * document-only. See "Adding handlers" in packages/api/README.md.
 */
import { defineHandlers } from "../runtime/handler.ts";

export const handlers = defineHandlers("Platform", {});
