"use server";

import { listAssetClasses } from "@xos/data/assets";
import { addPoLines, addProcurementNeeds, type QuickAddLine } from "@xos/data/procurement-needs";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { actionContext, finish } from "@/lib/collection-kit/actions";
import type { ActionState } from "@/lib/collection-kit/forms";
import { getOrgContext } from "@/lib/shell/context";
import { matchNamed, type Named } from "./match";

/** Where a pasted list goes: needs of a project, or lines of a Proposed order. */
export type MaterialTarget =
  | { readonly kind: "needs"; readonly projectId: string }
  | { readonly kind: "order"; readonly purchaseOrderId: string };

export interface MaterialResolution {
  readonly assetClassId: string | null;
  readonly elementId: string | null;
  readonly label: string;
}

/**
 * Resolves pasted items against the asset classes the caller may read (B11, G-107), so nothing outside them is ever
 * offered: one match names the item, anything else stays free text. An item with no match is null.
 */
export async function resolveMaterialLinesAction(
  org: string,
  target: MaterialTarget,
  items: readonly string[],
): Promise<(MaterialResolution | null)[]> {
  const ctx = await getOrgContext(org);
  if (!ctx) notFound();
  const classes = await listAssetClasses(ctx.viewer.db, ctx.org.id);
  if (!classes.ok) return items.map(() => null);
  const named: Named[] = classes.data.map((c) => ({ id: c.id, label: c.name, names: [c.name] }));
  const byId = new Map(classes.data.map((c) => [c.id, c]));
  return items.map((item) => {
    const hit = matchNamed(item, named);
    if (hit.status !== "resolved") return null;
    const found = byId.get(hit.id);
    if (!found) return null;
    return target.kind === "needs"
      ? { assetClassId: found.id, elementId: null, label: found.name }
      : { assetClassId: null, elementId: found.elementId, label: found.name };
  });
}

const LINES = z
  .array(
    z.object({
      description: z.string().trim().min(1).max(500),
      quantity: z.number().positive(),
      assetClassId: z.uuid().nullable(),
      elementId: z.string().max(100).nullable(),
    }),
  )
  .min(1)
  .max(200);

/** Add n lines: all in one transaction, so one bad line writes none. The database decides who may. */
export async function addMaterialLinesAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const kind = form.get("targetKind");
  const id = z.uuid().safeParse(form.get("targetId"));
  let raw: unknown = null;
  try {
    raw = JSON.parse(String(form.get("lines") ?? "null"));
  } catch {
    raw = null;
  }
  const lines = LINES.safeParse(raw);
  if (!id.success || !lines.success) return { error: "invalid" };
  const parsed: QuickAddLine[] = lines.data;
  const result =
    kind === "order"
      ? await addPoLines(ctx.viewer.db, id.data, parsed)
      : await addProcurementNeeds(ctx.viewer.db, id.data, parsed);
  if (result.ok) revalidatePath(`/${ctx.org.slug}/p`, "layout");
  return finish(result, ctx, "procurement");
}
