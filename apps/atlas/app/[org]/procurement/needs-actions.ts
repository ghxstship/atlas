"use server";

import {
  consolidateAllocations,
  createProcurementNeed,
  createSubHireRfq,
  deleteProcurementNeed,
  removeRfqLine,
  addRfqLine,
  setPoLineNeed,
  setProcurementNeedElement,
  unlinkNeedRequest,
  updateProcurementNeed,
  type NeedInput,
} from "@xos/data/procurement-needs";
import { searchAssetElements } from "@xos/data/assets";
import { ACQUISITION_KINDS, type AcquisitionKind } from "@xos/data/procurement";
import { randomUUID } from "node:crypto";
import { getOrgContext } from "@/lib/shell/context";
import type { XosClient } from "@xos/data";
import { actionContext, finish } from "@/lib/collection-kit/actions";
import { localToInstant } from "@/lib/operations/time";
import {
  all,
  decimal,
  FieldErrors,
  requiredText,
  text,
  uuid,
  type ActionState,
} from "@/lib/collection-kit/forms";

/**
 * Procurement needs and sub-hire (B11, G-180, G-97). Row level security and the 3001 and 3003 RPCs decide every write:
 * procurement.po.write for needs and links, with advancing.packet.read to consolidate, and procurement.rfq.write with
 * procurement.po.write for a sub-hire draft.
 */

const MODULE = "procurement";

/** The time zone of a project, read as the caller; what a person types is local to it. */
async function projectZone(db: XosClient, projectId: string | null): Promise<string> {
  if (projectId === null) return "UTC";
  const { data } = await db.from("projects").select("time_zone").eq("id", projectId).maybeSingle();
  return data?.time_zone ?? "UTC";
}

function localOrInvalid(form: FormData, name: string, zone: string): string | null | undefined {
  const value = text(form, name);
  if (value === null) return null;
  return localToInstant(value, zone) ?? undefined;
}

function needInput(form: FormData, errors: FieldErrors, zone: string): NeedInput | null {
  const description = errors.need("description", requiredText(form, "description", 500));
  const quantity = decimal(form, "quantity");
  if (quantity === undefined || quantity === null || quantity <= 0) errors.add("quantity", "number");
  const from = localOrInvalid(form, "neededFrom", zone);
  const to = localOrInvalid(form, "neededTo", zone);
  if (from === undefined) errors.add("neededFrom", "date");
  if (to === undefined) errors.add("neededTo", "date");
  if (from && to && to <= from) errors.add("neededTo", "date");
  if ((from && !to) || (to && !from)) errors.add(from ? "neededTo" : "neededFrom", "required");
  const note = text(form, "note");
  if (note && note.length > 1000) errors.add("note", "tooLong");
  if (errors.any || !description || typeof quantity !== "number") return null;
  return {
    description,
    quantity,
    unitBasis: text(form, "unitBasis"),
    assetClassId: uuid(form, "assetClassId"),
    neededFrom: from ?? null,
    neededTo: to ?? null,
    note,
  };
}

export async function createNeedAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const errors = new FieldErrors();
  const projectId = errors.need("projectId", uuid(form, "projectId"));
  const input = needInput(form, errors, await projectZone(ctx.viewer.db, projectId));
  if (errors.any || !projectId || !input) return errors.state;
  return finish(await createProcurementNeed(ctx.viewer.db, projectId, input), ctx, MODULE);
}

export async function updateNeedAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  const errors = new FieldErrors();
  const input = needInput(form, errors, await projectZone(ctx.viewer.db, uuid(form, "projectId")));
  if (errors.any || !input) return errors.state;
  return finish(await updateProcurementNeed(ctx.viewer.db, id, input), ctx, MODULE);
}

export async function deleteNeedAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await deleteProcurementNeed(ctx.viewer.db, id), ctx, MODULE);
}

/** Consolidates the chosen requests: onto the chosen need, else onto one new need per class. */
export async function consolidateAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const ids = all(form, "allocationId");
  if (ids.length === 0) return { fieldErrors: { allocationId: "required" } };
  return finish(await consolidateAllocations(ctx.viewer.db, ids, uuid(form, "needId")), ctx, MODULE);
}

export async function unlinkRequestAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "allocationId");
  if (id === null) return { error: "notFound" };
  return finish(await unlinkNeedRequest(ctx.viewer.db, id), ctx, MODULE);
}

/** Links the chosen order lines to a need; the need is the same for each, and one refusal stops the rest. */
export async function linkOrderLinesAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const needId = uuid(form, "needId");
  if (needId === null) return { error: "notFound" };
  const lines = all(form, "poLineId");
  if (lines.length === 0) return { fieldErrors: { poLineId: "required" } };
  for (const line of lines) {
    const result = await setPoLineNeed(ctx.viewer.db, line, needId);
    if (!result.ok) return finish(result, ctx, MODULE);
  }
  return finish({ ok: true, data: null }, ctx, MODULE);
}

export async function unlinkOrderLineAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "poLineId");
  if (id === null) return { error: "notFound" };
  return finish(await setPoLineNeed(ctx.viewer.db, id, null), ctx, MODULE);
}

/** Request sub-hire: the event id is in the form, so a second click replays the same draft. */
export async function requestSubHireAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const projectId = uuid(form, "projectId");
  const classId = uuid(form, "assetClassId");
  const title = requiredText(form, "title", 200);
  if (projectId === null || classId === null || title === null) return { error: "notFound" };
  return finish(
    await createSubHireRfq(ctx.viewer.db, {
      eventId: uuid(form, "eventId") ?? randomUUID(),
      projectId,
      assetClassIds: [classId],
      title,
    }),
    ctx,
    MODULE,
  );
}

export async function addRfqLineAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const rfqId = uuid(form, "rfqId");
  if (rfqId === null) return { error: "notFound" };
  const errors = new FieldErrors();
  const description = errors.need("description", requiredText(form, "description", 500));
  const quantity = decimal(form, "quantity");
  if (quantity === undefined || quantity === null || quantity <= 0) errors.add("quantity", "number");
  const kindText = text(form, "acquisitionKind") ?? "Purchase";
  const kind = (ACQUISITION_KINDS as readonly string[]).includes(kindText)
    ? (kindText as AcquisitionKind)
    : "Purchase";
  const zone = await projectZone(ctx.viewer.db, uuid(form, "projectId"));
  const from = localOrInvalid(form, "hireFrom", zone);
  const to = localOrInvalid(form, "hireTo", zone);
  if (kind === "Rental" && (!from || !to || to <= from)) errors.add(from ? "hireTo" : "hireFrom", "date");
  if (errors.any || !description || typeof quantity !== "number") return errors.state;
  return finish(
    await addRfqLine(ctx.viewer.db, rfqId, {
      description,
      quantity,
      unitBasis: text(form, "unitBasis"),
      acquisitionKind: kind,
      hireFrom: from ?? null,
      hireTo: to ?? null,
    }),
    ctx,
    MODULE,
  );
}

export async function removeRfqLineAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  if (id === null) return { error: "notFound" };
  return finish(await removeRfqLine(ctx.viewer.db, id), ctx, MODULE);
}

/** Suggest categories: the person confirmed the element Aurora offered, so the need names it. Its proposal is never applied. */
export async function setNeedElementAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await actionContext(form);
  const id = uuid(form, "id");
  const elementId = requiredText(form, "elementId", 100);
  if (id === null || elementId === null) return { error: "notFound" };
  return finish(await setProcurementNeedElement(ctx.viewer.db, id, elementId), ctx, MODULE);
}

/** The catalog elements a need's words might mean, read by the server, so Aurora chooses only among these. */
export async function findNeedCandidatesAction(
  org: string,
  description: string,
): Promise<{ element_id: string; name: string; urid: string }[]> {
  const ctx = await getOrgContext(org);
  if (!ctx) return [];
  const found = await searchAssetElements(ctx.viewer.db, description.slice(0, 100));
  return found.ok
    ? found.data.map((e) => ({ element_id: e.elementId, name: e.item, urid: e.urid }))
    : [];
}
