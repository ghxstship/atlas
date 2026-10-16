"use server";

import { transitionAiSuggestion } from "@xos/data/ai";
import { confirmRiderLineProposals, type RiderLineProposal } from "@xos/data/advancing";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Stores the rider lines a person chose from an Aurora extraction (Section 4.7) with A10's
 * confirmRiderLineProposals, then closes every suggestion of that extraction: chosen lines are
 * Confirmed and Applied with the line written, the rest and the rider header are Rejected. Row level
 * security decides the writes; the suggestion RPC lets only the person who asked decide.
 */
export interface RiderExtractionResult {
  readonly ok: boolean;
  readonly error?: string;
}

const Chosen = z.object({
  suggestionId: z.uuid(),
  description: z.string().min(1).max(2000),
  quantity: z.number().nullable(),
  confidence: z.number().min(0).max(1),
  source: z.string().nullable(),
});

const Input = z.object({
  org: z.string().min(1),
  riderId: z.uuid(),
  chosen: z.array(Chosen).max(200),
  others: z.array(z.uuid()).max(201),
});

export async function confirmRiderExtractionAction(raw: unknown): Promise<RiderExtractionResult> {
  const parsed = Input.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "invalid" };
  const input = parsed.data;
  const ctx = await getOrgContext(input.org);
  if (!ctx) notFound();
  const db = ctx.viewer.db;

  const proposals: RiderLineProposal[] = input.chosen.map((c) => ({
    description: c.description,
    elementId: null,
    quantity: c.quantity,
    confidence: c.confidence,
    source: c.source,
  }));
  const stored = await confirmRiderLineProposals(db, {
    orgId: ctx.org.id,
    riderId: input.riderId,
    proposals,
  });
  if (!stored.ok) {
    return {
      ok: false,
      error: stored.error.kind === "refusal" ? stored.error.rule : stored.error.kind,
    };
  }

  // The lines are stored; a suggestion left open is reported, never hidden.
  let unclosed = 0;
  for (const [index, c] of input.chosen.entries()) {
    const lineId = stored.data.ids[index];
    const confirmed = await transitionAiSuggestion(db, {
      id: c.suggestionId,
      expected: "Proposed",
      next: "Confirmed",
      reason: "Chosen in the rider review.",
    });
    const applied =
      confirmed.ok && lineId
        ? await transitionAiSuggestion(db, {
            id: c.suggestionId,
            expected: "Confirmed",
            next: "Applied",
            reason: "Stored as a rider line.",
            appliedId: lineId,
          })
        : confirmed;
    if (!applied.ok || !lineId) unclosed += 1;
  }
  for (const id of input.others) {
    const rejected = await transitionAiSuggestion(db, {
      id,
      expected: "Proposed",
      next: "Rejected",
      reason: "Not chosen in the rider review.",
    });
    if (!rejected.ok) unclosed += 1;
  }
  revalidatePath(`/${ctx.org.slug}/advancing/riders`);
  return unclosed === 0 ? { ok: true } : { ok: true, error: "suggestions_open" };
}
