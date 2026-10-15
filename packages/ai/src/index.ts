/**
 * @xos/ai: Aurora AI (Section 4.7, ADR 0020). Prompts, tools, redaction, the silence rule and the
 * request runner. The Anthropic client lives in `@xos/ai/anthropic` so browser bundles never load it.
 */
export * from "./model.ts";
export * from "./config.ts";
export * from "./redact.ts";
export * from "./session.ts";
export * from "./features/assistant.ts";
export * from "./features/filters.ts";
export * from "./features/extraction.ts";
export * from "./features/drafting.ts";
export * from "./features/summaries.ts";
export * from "./features/mapping.ts";
export { GUARDRAILS } from "./features/shared.ts";
