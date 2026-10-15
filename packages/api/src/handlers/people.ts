/**
 * People handlers (A13). Role assignments, requisitions and agreements are corrected to the People
 * schema of migration 0361 in catalog/modules/people.ts (ADR 0023) and stay document-only until
 * their corrected shapes have handlers; the Atlas pages serve them through @xos/data/people. Offer
 * handlers are a separate block owned by the offers agent.
 */
import { defineHandlers } from "../runtime/handler.ts";

export const handlers = defineHandlers("People", {});
