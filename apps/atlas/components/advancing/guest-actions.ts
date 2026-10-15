"use server";

import type { DataError, Result } from "@xos/data";
import { addGuest, checkInGuest, decideGuest, removeGuest, updateGuest } from "@xos/data/advancing";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import type { AdvancingState } from "./actions";
import { KNOWN_ERRORS } from "./errors";

/**
 * Guest list actions (0431). The database decides every move: review authority and
 * sod_guest_requester for decisions, Approved before Checked In, a decided guest keeps its guest.
 */

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

function done<T>(slug: string, result: Result<T>): AdvancingState {
  if (!result.ok) return { error: errorKey(result.error) };
  revalidatePath(`/${slug}`, "layout");
  return { ok: true };
}

function errorKey(error: DataError): string {
  if (error.kind === "refusal") return KNOWN_ERRORS.has(error.rule) ? error.rule : "refused";
  return error.kind;
}

const id = z.uuid();
const guestFields = z.object({
  guestName: z.string().trim().min(1).max(200),
  plusOnes: z.coerce.number().int().min(0).max(20),
  note: z
    .string()
    .trim()
    .max(500)
    .transform((v) => (v.length === 0 ? null : v)),
  scopeNodeId: z
    .string()
    .trim()
    .transform((v) => (v.length === 0 ? null : v))
    .pipe(z.uuid().nullable()),
});

function read(form: FormData) {
  const text = (key: string) => {
    const value = form.get(key);
    return typeof value === "string" ? value : "";
  };
  return {
    guestName: text("guestName"),
    plusOnes: text("plusOnes") || "0",
    note: text("note"),
    scopeNodeId: text("scopeNodeId"),
  };
}

function fieldErrors(error: z.ZodError): AdvancingState {
  const fields = new Set(error.issues.map((i) => String(i.path[0])));
  return { fieldErrors: Object.fromEntries([...fields].map((f) => [f, f])) };
}

export async function addGuestAction(_: AdvancingState, form: FormData): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const projectId = id.safeParse(form.get("projectId"));
  const guest = guestFields.safeParse(read(form));
  if (!projectId.success) return { error: "invalid" };
  if (!guest.success) return fieldErrors(guest.error);
  return done(
    ctx.org.slug,
    await addGuest(ctx.viewer.db, {
      orgId: ctx.org.id,
      projectId: projectId.data,
      approve: form.get("approve") === "true",
      ...guest.data,
    }),
  );
}

export async function updateGuestAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const guestId = id.safeParse(form.get("guestId"));
  const guest = guestFields.safeParse(read(form));
  if (!guestId.success) return { error: "invalid" };
  if (!guest.success) return fieldErrors(guest.error);
  return done(ctx.org.slug, await updateGuest(ctx.viewer.db, guestId.data, guest.data));
}

export async function moveGuestAction(_: AdvancingState, form: FormData): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ guestId: id, to: z.enum(["Approved", "Declined", "Checked In"]) })
    .safeParse({ guestId: form.get("guestId"), to: form.get("to") });
  if (!parsed.success) return { error: "invalid" };
  const { guestId, to } = parsed.data;
  return done(
    ctx.org.slug,
    to === "Checked In"
      ? await checkInGuest(ctx.viewer.db, guestId)
      : await decideGuest(ctx.viewer.db, guestId, to),
  );
}

export async function removeGuestAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const guestId = id.safeParse(form.get("guestId"));
  if (!guestId.success) return { error: "invalid" };
  return done(ctx.org.slug, await removeGuest(ctx.viewer.db, guestId.data));
}
