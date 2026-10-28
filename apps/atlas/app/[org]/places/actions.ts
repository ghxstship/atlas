"use server";

import {
  addSitePlanPin,
  createCapabilityDocument,
  createSitePlan,
  createSpace,
  createVenue,
  createZone,
  freezeCapabilityDocument,
  moveSitePlanPin,
  setPlaceArchived,
  setVenueLocation,
  updateCapabilityDocument,
  updateSitePlan,
  updateSpace,
  updateVenue,
  updateZone,
  type PlacesTable,
} from "@xos/data/places";
import {
  archiveCapabilityStatement,
  createCapabilityStatement,
  reconcileProject,
  updateCapabilityStatement,
  type CapabilityDirection,
} from "@xos/data/reconciliation";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { count, errorKey, text, type ActionState } from "@/components/places/kit/action-state";
import { ADDRESS_ERROR, readAddress } from "@/lib/address";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Places actions. Each resolves the viewer's org context again (404 when it is gone), validates the
 * form, and calls the repository; row level security, the RPCs and the guards of migrations 0301,
 * 0350, 0351 and 0420 decide every write, and their refusals come back as catalog keys under
 * `places.errors`.
 */

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

function refresh(slug: string) {
  revalidatePath(`/${slug}/places`, "layout");
}

const uuid = z.uuid();
const isoDate = z.iso.date();

// Venues ------------------------------------------------------------------------------------------

export async function saveVenueAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const fieldErrors: Record<string, string> = {};
  const name = text(form, "name");
  const jurisdictionId = text(form, "jurisdictionId");
  const timeZone = text(form, "timeZone");
  if (!name || name.length > 200) fieldErrors["name"] = "name";
  if (!jurisdictionId) fieldErrors["jurisdictionId"] = "jurisdiction";
  if (!timeZone) fieldErrors["timeZone"] = "timeZone";
  const latitude = text(form, "latitude");
  const longitude = text(form, "longitude");
  const lat = latitude === null ? null : Number(latitude);
  const lng = longitude === null ? null : Number(longitude);
  // The venue's state is its jurisdiction's, so the form does not ask for it.
  const address = readAddress(form, jurisdictionId?.slice(0, 2) ?? null, ["administrativeArea"]);
  if (!address.ok) {
    for (const [field, problem] of Object.entries(address.problems)) {
      fieldErrors[field] = ADDRESS_ERROR[problem];
    }
  }
  if ((lat === null) !== (lng === null)) fieldErrors["latitude"] = "locationPair";
  if (lat !== null && (!Number.isFinite(lat) || lat < -90 || lat > 90)) {
    fieldErrors["latitude"] = "latitude";
  }
  if (lng !== null && (!Number.isFinite(lng) || lng < -180 || lng > 180)) {
    fieldErrors["longitude"] = "longitude";
  }
  if (Object.keys(fieldErrors).length > 0 || !name || !jurisdictionId || !timeZone || !address.ok) {
    return { fieldErrors };
  }
  const input = {
    name,
    jurisdictionId,
    timeZone,
    streetAddress: address.value.streetAddress,
    locality: address.value.locality,
    postalCode: address.value.postalCode,
  };
  const id = text(form, "id");
  const saved =
    id === null
      ? await createVenue(ctx.viewer.db, ctx.org.id, input)
      : await updateVenue(ctx.viewer.db, id, input);
  if (!saved.ok) return { error: errorKey(saved.error) };
  const located = await setVenueLocation(
    ctx.viewer.db,
    saved.data.id,
    lat === null || lng === null ? null : { latitude: lat, longitude: lng },
  );
  refresh(ctx.org.slug);
  if (!located.ok) return { error: errorKey(located.error), id: saved.data.id };
  return { ok: true, id: saved.data.id };
}

// Archive and restore --------------------------------------------------------------------------------

const ARCHIVABLE: readonly PlacesTable[] = [
  "venues",
  "spaces",
  "zones",
  "capability_documents",
  "site_plans",
  "site_plan_pins",
];

export async function setPlaceArchivedAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const table = text(form, "table") as PlacesTable | null;
  const id = uuid.safeParse(form.get("id"));
  if (!table || !ARCHIVABLE.includes(table) || !id.success) return { error: "notFound" };
  const result = await setPlaceArchived(
    ctx.viewer.db,
    table,
    id.data,
    form.get("archived") === "true",
  );
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: id.data };
}

// Spaces and zones -------------------------------------------------------------------------------------

export async function saveSpaceAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const name = text(form, "name");
  const venueId = uuid.safeParse(form.get("venueId"));
  const area = count(form, "areaSqFt");
  const capacity = count(form, "capacity");
  const fieldErrors: Record<string, string> = {};
  if (!name || name.length > 200) fieldErrors["name"] = "name";
  if (!venueId.success) fieldErrors["venueId"] = "venue";
  if (area === "invalid" || area === 0) fieldErrors["areaSqFt"] = "positive";
  if (
    capacity === "invalid" ||
    capacity === 0 ||
    (capacity !== null && !Number.isInteger(capacity))
  ) {
    fieldErrors["capacity"] = "wholePositive";
  }
  if (Object.keys(fieldErrors).length > 0 || !name || !venueId.success) return { fieldErrors };
  const input = {
    name,
    urid: text(form, "urid"),
    areaSqFt: area === "invalid" ? null : area,
    capacity: capacity === "invalid" ? null : capacity,
  };
  const id = text(form, "id");
  const saved =
    id === null
      ? await createSpace(ctx.viewer.db, { ...input, venueId: venueId.data })
      : await updateSpace(ctx.viewer.db, id, input);
  if (!saved.ok) return { error: errorKey(saved.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: saved.data.id };
}

export async function saveZoneAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const name = text(form, "name");
  const code = text(form, "code")?.toUpperCase() ?? null;
  const venueId = uuid.safeParse(form.get("venueId"));
  const fieldErrors: Record<string, string> = {};
  if (!name || name.length > 200) fieldErrors["name"] = "name";
  if (!code || !/^[A-Z0-9][A-Z0-9-]{0,15}$/.test(code)) fieldErrors["code"] = "zoneCode";
  if (!venueId.success) fieldErrors["venueId"] = "venue";
  if (Object.keys(fieldErrors).length > 0 || !name || !code || !venueId.success) {
    return { fieldErrors };
  }
  const spaceId = text(form, "spaceId");
  const id = text(form, "id");
  const saved =
    id === null
      ? await createZone(ctx.viewer.db, { venueId: venueId.data, spaceId, code, name })
      : await updateZone(ctx.viewer.db, id, { spaceId, code, name });
  if (!saved.ok) return { error: errorKey(saved.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: saved.data.id };
}

// Capability documents ------------------------------------------------------------------------------------

export async function saveCapabilityDocumentAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const title = text(form, "title");
  const documentUri = text(form, "documentUri");
  const venueId = uuid.safeParse(form.get("venueId"));
  const validFrom = isoDate.safeParse(text(form, "validFrom"));
  const validToRaw = text(form, "validTo");
  const validTo = validToRaw === null ? null : isoDate.safeParse(validToRaw);
  const fieldErrors: Record<string, string> = {};
  if (!title || title.length > 200) fieldErrors["title"] = "title";
  if (!documentUri) fieldErrors["documentUri"] = "documentUri";
  if (!venueId.success) fieldErrors["venueId"] = "venue";
  if (!validFrom.success) fieldErrors["validFrom"] = "date";
  if (validTo !== null && !validTo.success) fieldErrors["validTo"] = "date";
  if (validFrom.success && validTo !== null && validTo.success && validTo.data < validFrom.data) {
    fieldErrors["validTo"] = "validity";
  }
  if (
    Object.keys(fieldErrors).length > 0 ||
    !title ||
    !documentUri ||
    !venueId.success ||
    !validFrom.success
  ) {
    return { fieldErrors };
  }
  const input = {
    title,
    documentUri,
    validFrom: validFrom.data,
    validTo: validTo?.success ? validTo.data : null,
  };
  const id = text(form, "id");
  const saved =
    id === null
      ? await createCapabilityDocument(ctx.viewer.db, { ...input, venueId: venueId.data })
      : await updateCapabilityDocument(ctx.viewer.db, id, input);
  if (!saved.ok) return { error: errorKey(saved.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: saved.data.id };
}

export async function freezeCapabilityDocumentAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return { error: "notFound" };
  const result = await freezeCapabilityDocument(ctx.viewer.db, id.data);
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: id.data };
}

// Site plans ---------------------------------------------------------------------------------------------------

export async function saveSitePlanAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const title = text(form, "title");
  const imageUri = text(form, "imageUri");
  const projectId = uuid.safeParse(form.get("projectId"));
  const fieldErrors: Record<string, string> = {};
  if (!title || title.length > 200) fieldErrors["title"] = "title";
  if (!imageUri) fieldErrors["imageUri"] = "imageUri";
  const id = text(form, "id");
  if (id === null && !projectId.success) fieldErrors["projectId"] = "project";
  if (Object.keys(fieldErrors).length > 0 || !title || !imageUri) return { fieldErrors };
  const venueId = text(form, "venueId");
  const saved =
    id === null && projectId.success
      ? await createSitePlan(ctx.viewer.db, { projectId: projectId.data, venueId, title, imageUri })
      : await updateSitePlan(ctx.viewer.db, id ?? "", { venueId, title, imageUri });
  if (!saved.ok) return { error: errorKey(saved.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: saved.data.id };
}

function ratio(form: FormData, key: string): number | null {
  const raw = text(form, key);
  if (raw === null) return null;
  const value = Number(raw) / 100;
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/** Places a pin. Positions are percentages of the drawing in the form and fractions in the database. */
export async function addPinAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const sitePlanId = uuid.safeParse(form.get("sitePlanId"));
  const label = text(form, "label");
  const x = ratio(form, "x");
  const y = ratio(form, "y");
  const fieldErrors: Record<string, string> = {};
  if (!label || label.length > 200) fieldErrors["label"] = "label";
  if (x === null) fieldErrors["x"] = "percent";
  if (y === null) fieldErrors["y"] = "percent";
  if (
    Object.keys(fieldErrors).length > 0 ||
    !sitePlanId.success ||
    !label ||
    x === null ||
    y === null
  ) {
    return { fieldErrors };
  }
  const result = await addSitePlanPin(ctx.viewer.db, {
    sitePlanId: sitePlanId.data,
    label,
    x,
    y,
    zoneId: text(form, "zoneId"),
  });
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: result.data.id };
}

export async function movePinAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = uuid.safeParse(form.get("id"));
  const x = ratio(form, "x");
  const y = ratio(form, "y");
  if (!id.success || x === null || y === null) return { fieldErrors: { x: "percent" } };
  const result = await moveSitePlanPin(ctx.viewer.db, id.data, { x, y });
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: id.data };
}

// Requirements, capabilities and reconciliation -----------------------------------------------------------------

export async function saveCapabilityStatementAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const direction = text(form, "direction") as CapabilityDirection | null;
  const urid = text(form, "urid");
  const description = text(form, "description");
  const quantity = count(form, "quantity");
  const fieldErrors: Record<string, string> = {};
  if (direction !== "Require" && direction !== "Provide") fieldErrors["direction"] = "direction";
  if (!urid) fieldErrors["urid"] = "urid";
  if (!description || description.length > 500) fieldErrors["description"] = "description";
  if (quantity === "invalid") fieldErrors["quantity"] = "positive";
  const venueId = text(form, "venueId");
  if (direction === "Provide" && !venueId) fieldErrors["venueId"] = "provider";
  const projectId = uuid.safeParse(form.get("projectId"));
  if (!projectId.success) fieldErrors["projectId"] = "project";
  if (
    Object.keys(fieldErrors).length > 0 ||
    !urid ||
    !description ||
    !projectId.success ||
    (direction !== "Require" && direction !== "Provide")
  ) {
    return { fieldErrors };
  }
  const input = {
    urid,
    description,
    quantity: quantity === "invalid" ? null : quantity,
    unitBasis: text(form, "unitBasis"),
    critical: form.get("critical") === "on",
    assertionWord: direction === "Provide" ? (text(form, "assertionWord") ?? "UNKNOWN") : "UNKNOWN",
    venueId: direction === "Provide" ? venueId : null,
  };
  const id = text(form, "id");
  const saved =
    id === null
      ? await createCapabilityStatement(ctx.viewer.db, {
          ...input,
          projectId: projectId.data,
          direction,
        })
      : await updateCapabilityStatement(ctx.viewer.db, id, input);
  if (!saved.ok) return { error: errorKey(saved.error) };
  refresh(ctx.org.slug);
  revalidatePath(`/${ctx.org.slug}/p`, "layout");
  return { ok: true, id: saved.data.id };
}

export async function archiveCapabilityStatementAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return { error: "notFound" };
  const result = await archiveCapabilityStatement(ctx.viewer.db, id.data);
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  revalidatePath(`/${ctx.org.slug}/p`, "layout");
  return { ok: true };
}

export async function reconcileProjectAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const projectId = uuid.safeParse(form.get("projectId"));
  if (!projectId.success) return { error: "notFound" };
  const result = await reconcileProject(ctx.viewer.db, projectId.data, text(form, "note"));
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  revalidatePath(`/${ctx.org.slug}/p`, "layout");
  return { ok: true, id: result.data.id };
}
