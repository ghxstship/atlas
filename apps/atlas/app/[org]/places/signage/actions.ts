"use server";

import { uploadAttachment } from "@xos/data/attachments";
import { addSitePlanPin } from "@xos/data/places";
import {
  createSign,
  markSignStep,
  setSignArtwork,
  SIGN_TYPES,
  updateSign,
  type SignInput,
  type SignStep,
  type SignType,
} from "@xos/data/signage";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { errorKey, text, type ActionState } from "@/components/places/kit/action-state";
import { customFieldsOf } from "@/lib/custom-fields/form";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Signage register actions (G-24, migrations 2904 and 2905, ADR 0140 D6). Each resolves the viewer's org context again
 * (404 when it is gone) and validates the form; the signs policy (places.site_plan.write on the project) and
 * private.guard_sign decide every write, and app.mark_sign_step stamps the steps. Sizes are typed in the viewer's
 * units and stored in inches.
 */

async function contextFor(org: unknown) {
  const ctx = typeof org === "string" ? await getOrgContext(org) : null;
  if (!ctx) notFound();
  return ctx;
}

function refresh(slug: string) {
  revalidatePath(`/${slug}/places`, "layout");
}

const uuid = z.uuid();
const STEPS: readonly SignStep[] = ["Ordered", "Printed", "Placed"];
const ARTWORK_TYPES = new Set(["image/png", "image/jpeg", "application/pdf"]);

function size(form: FormData, key: string, metric: boolean): number | null | "invalid" {
  const raw = text(form, key);
  if (raw === null) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return "invalid";
  const inches = metric ? value / 2.54 : value;
  return inches <= 1200 ? Math.round(inches * 100) / 100 : "invalid";
}

export async function saveSignAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form.get("org"));
  const id = text(form, "id");
  const projectId = uuid.safeParse(form.get("projectId"));
  const title = text(form, "title");
  const type = text(form, "type") as SignType | null;
  const quantity = Number(text(form, "quantity") ?? "1");
  const metric = text(form, "units") === "metric";
  const width = size(form, "width", metric);
  const height = size(form, "height", metric);
  const fieldErrors: Record<string, string> = {};
  if (!title || title.length > 200) fieldErrors["title"] = "title";
  if (!type || !SIGN_TYPES.includes(type)) fieldErrors["type"] = "signType";
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000)
    fieldErrors["quantity"] = "signQuantity";
  if (width === "invalid") fieldErrors["width"] = "signSize";
  if (height === "invalid") fieldErrors["height"] = "signSize";
  if (id === null && !projectId.success) fieldErrors["projectId"] = "project";
  const message = text(form, "message");
  if (message && message.length > 2000) fieldErrors["message"] = "tooLong";
  const pinMode = text(form, "pin");
  const location = text(form, "locationText");
  if (location && location.length > 300) fieldErrors["locationText"] = "tooLong";
  if (
    Object.keys(fieldErrors).length > 0 ||
    !title ||
    !type ||
    width === "invalid" ||
    height === "invalid"
  ) {
    return { fieldErrors };
  }
  // "New pin here" places a pin on a Draft plan first; a Locked or Live plan offers only its existing pins.
  let sitePlanPinId = pinMode && uuid.safeParse(pinMode).success ? pinMode : null;
  if (pinMode === "new") {
    const planId = uuid.safeParse(form.get("sitePlanId"));
    const x = Number(text(form, "pinX")) / 100;
    const y = Number(text(form, "pinY")) / 100;
    if (!planId.success || !(x >= 0 && x <= 1) || !(y >= 0 && y <= 1))
      return { fieldErrors: { pin: "percent" } };
    const pin = await addSitePlanPin(ctx.viewer.db, {
      sitePlanId: planId.data,
      label: title,
      x,
      y,
    });
    if (!pin.ok) return { error: errorKey(pin.error) };
    sitePlanPinId = pin.data.id;
  }
  const poRaw = form.get("poLineId");
  const input: Omit<SignInput, "projectId"> = {
    title,
    type,
    message,
    quantity,
    widthIn: width,
    heightIn: height,
    substrate: text(form, "substrate"),
    doubleSided: form.get("doubleSided") === "on",
    sitePlanPinId,
    locationText: sitePlanPinId ? null : location,
    printerVendorId: text(form, "printerVendorId"),
    neededBy: text(form, "neededBy"),
    // The order line is sent only by the form a procurement reader sees; otherwise the sign's line is kept.
    ...(typeof poRaw === "string"
      ? { poLineId: poRaw && uuid.safeParse(poRaw).success ? poRaw : null }
      : {}),
  };
  const custom = await customFieldsOf(ctx, "app.signs", id === null ? form : undefined);
  if (custom.fieldErrors) return { error: "invalid", fieldErrors: custom.fieldErrors };
  const saved =
    id === null && projectId.success
      ? await createSign(ctx.viewer.db, { ...input, projectId: projectId.data })
      : await updateSign(ctx.viewer.db, id ?? "", input);
  if (!saved.ok) return { error: errorKey(saved.error) };
  if (id === null) await custom.save(saved.data.id);
  refresh(ctx.org.slug);
  return { ok: true, id: saved.data.id };
}

export async function markSignStepAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form.get("org"));
  const id = uuid.safeParse(form.get("id"));
  const step = text(form, "step") as SignStep | null;
  if (!id.success || !step || !STEPS.includes(step)) return { error: "notFound" };
  const result = await markSignStep(ctx.viewer.db, {
    id: id.data,
    step,
    done: form.get("done") !== "false",
  });
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: id.data };
}

/** Uploads artwork as an attachment on the sign; once it scans Clean it can be set as the sign's artwork. */
export async function uploadSignArtworkAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form.get("org"));
  const id = uuid.safeParse(form.get("id"));
  const file = form.get("file");
  if (!id.success) return { error: "notFound" };
  if (!(file instanceof File) || file.size === 0) return { fieldErrors: { file: "fileRequired" } };
  if (!ARTWORK_TYPES.has(file.type)) return { fieldErrors: { file: "artworkType" } };
  const result = await uploadAttachment(ctx.viewer.db, {
    subject: { table: "app.signs", id: id.data },
    file,
    filename: file.name,
  });
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: id.data };
}

export async function setSignArtworkAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form.get("org"));
  const id = uuid.safeParse(form.get("id"));
  const versionRaw = text(form, "versionId");
  if (!id.success || (versionRaw && !uuid.safeParse(versionRaw).success))
    return { error: "notFound" };
  const result = await setSignArtwork(ctx.viewer.db, id.data, versionRaw);
  if (!result.ok) return { error: errorKey(result.error) };
  refresh(ctx.org.slug);
  return { ok: true, id: id.data };
}
