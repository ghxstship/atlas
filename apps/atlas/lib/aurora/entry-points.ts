import type { AiFeature } from "@xos/data/ai";

/**
 * Where each Aurora AI Features switch takes effect (A95, finding A65-020). The switches live in
 * app.ai_settings (migration 0650), not in the settings registry, so the registry's `enforced_by`
 * guard (A76, A65-001) cannot see them; this list is that guard for them. Each switch names the
 * modules that read it (the file, and the symbol that checks the feature key) and a test that turns
 * it on or off and observes the entry point. `test/aurora-entry-points.test.ts` fails when a
 * consumer or test no longer names its feature, or when a feature has no consumer.
 */
export interface EntryPoint {
  /** Repository-relative file, then `#` and the symbol that reads the feature key. */
  readonly consumer: string;
  /** Repository-relative test that changes the switch and observes the entry point. */
  readonly test: string;
}

export const AI_ENTRY_POINTS: Readonly<Record<AiFeature, readonly EntryPoint[]>> = {
  assistant: [
    {
      consumer: "packages/ai/src/conversation.ts#availabilityOf",
      test: "apps/atlas/e2e/aurora-journeys.spec.ts",
    },
  ],
  plain_language: [
    {
      consumer: "apps/atlas/components/aurora/entry/ask-entry.tsx#AskFilterEntry",
      test: "apps/atlas/e2e/a95-ai-entry-points.spec.ts",
    },
  ],
  extraction: [
    {
      consumer: "apps/atlas/components/aurora/entry/extract-entry.tsx#ExtractEntry",
      test: "apps/atlas/e2e/a95-ai-entry-points.spec.ts",
    },
    {
      consumer: "apps/atlas/components/aurora/certificate-extraction.tsx#CertificateExtraction",
      test: "apps/atlas/e2e/a95-ai-entry-points.spec.ts",
    },
  ],
  drafting: [
    {
      consumer: "apps/atlas/components/aurora/entry/draft-entry.tsx#DraftEntry",
      test: "apps/atlas/e2e/a95-ai-entry-points.spec.ts",
    },
  ],
  summaries: [
    {
      consumer: "apps/atlas/components/aurora/entry/summary-entry.tsx#SummaryEntry",
      test: "apps/atlas/e2e/a95-ai-entry-points.spec.ts",
    },
  ],
  mapping: [
    {
      consumer: "apps/atlas/components/aurora/entry/binding-entry.tsx#BindingEntry",
      test: "apps/atlas/e2e/a95-ai-entry-points.spec.ts",
    },
    {
      consumer: "apps/atlas/components/imports/import-aurora.tsx#ImportAuroraSuggest",
      test: "apps/atlas/e2e/a83-imports.spec.ts",
    },
  ],
};
