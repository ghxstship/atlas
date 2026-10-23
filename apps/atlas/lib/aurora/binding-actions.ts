"use server";

import { searchElements } from "@xos/data/canon";
import { createCatalogBinding } from "@xos/data/procurement";
import { resolveScanIntake } from "@xos/data/scan-intake";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { applySuggestions } from "./suggestions";

/**
 * Suggest binding in the scan intake queue (A95, Section 4.7 mapping help, Section 3.9): the
 * candidates Aurora may choose from, and the confirmation that binds the code. Nothing is bound
 * automatically: the person confirms the element and the name, then the catalog binding is written
 * as them (row level security, procurement.catalog.write), the scan is resolved Created with the
 * binding it became (credentials.scan.write), and Aurora's suggestion is applied with that binding.
 */

export interface Candidate {
  readonly elementId: string;
  readonly name: string;
  readonly urid: string;
}

/** The most candidates one suggestion weighs (aurora.bindCode takes at most 50). */
const MAX_CANDIDATES = 20;

const Search = z.object({
  org: z.string().min(1).max(100),
  query: z.string().trim().min(1).max(200),
});

/** Catalog elements whose name, common name, element ID or URID matches the words given. */
export async function bindingCandidatesAction(
  raw: unknown,
): Promise<{ ok: true; candidates: Candidate[] } | { ok: false }> {
  const parsed = Search.safeParse(raw);
  if (!parsed.success) return { ok: false };
  const ctx = await getOrgContext(parsed.data.org);
  if (!ctx) return { ok: false };
  // Each word on its own, then the whole phrase: a label rarely matches an element name exactly.
  const words = parsed.data.query.split(/\s+/).filter((w) => w.length >= 3);
  const seen = new Map<string, Candidate>();
  for (const term of [parsed.data.query, ...words]) {
    if (seen.size >= MAX_CANDIDATES) break;
    const found = await searchElements(ctx.viewer.db, term, MAX_CANDIDATES);
    if (!found.ok) return { ok: false };
    for (const e of found.data) {
      if (seen.size < MAX_CANDIDATES && !seen.has(e.id)) {
        seen.set(e.id, { elementId: e.id, name: e.name, urid: e.urid });
      }
    }
  }
  return { ok: true, candidates: [...seen.values()] };
}

const Bind = z.object({
  org: z.string().min(1).max(100),
  scanId: z.uuid(),
  suggestionId: z.uuid(),
  elementId: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  code: z.string().min(1).max(2000),
});

export type BindResult =
  | { readonly ok: true; readonly bindingId: string }
  | {
      readonly ok: false;
      /** Where it stopped: nothing written, or the binding written but the scan still open. */
      readonly stage: "binding" | "resolution";
      readonly rule: string | null;
    };

export async function bindScanAction(raw: unknown): Promise<BindResult> {
  const parsed = Bind.safeParse(raw);
  if (!parsed.success) return { ok: false, stage: "binding", rule: "invalid" };
  const input = parsed.data;
  const ctx = await getOrgContext(input.org);
  if (!ctx) return { ok: false, stage: "binding", rule: "not_found" };
  const db = ctx.viewer.db;
  const binding = await createCatalogBinding(db, ctx.org.id, {
    elementId: input.elementId,
    name: input.name,
    unitBasis: null,
    defaultUnitPriceMinor: null,
    currencyCode: null,
  });
  if (!binding.ok) {
    return {
      ok: false,
      stage: "binding",
      rule: binding.error.kind === "refusal" ? binding.error.rule : binding.error.kind,
    };
  }
  const resolved = await resolveScanIntake(db, input.scanId, {
    resolution: "Created",
    subjectTable: "catalog_bindings",
    subjectId: binding.data.id,
    note: `Code ${input.code.slice(0, 200)} bound to ${input.name} after Aurora's suggestion.`,
  });
  await applySuggestions(
    db,
    [input.suggestionId],
    binding.data.id,
    "Bound from the scan intake queue after review.",
  );
  revalidatePath(`/${ctx.org.slug}`, "layout");
  if (!resolved.ok) {
    return {
      ok: false,
      stage: "resolution",
      rule: resolved.error.kind === "refusal" ? resolved.error.rule : resolved.error.kind,
    };
  }
  return { ok: true, bindingId: binding.data.id };
}
