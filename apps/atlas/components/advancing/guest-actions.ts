"use server";

import type { DataError, Result } from "@xos/data";
import {
  addGuest,
  checkInGuest,
  decideGuest,
  guestEmailSendSummary,
  queueGuestEmails,
  removeGuest,
  updateGuest,
  updateGuestPass,
  type GuestEmailSummary,
  type GuestPassInput,
} from "@xos/data/advancing";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import type { AdvancingState } from "./actions";
import { KNOWN_ERRORS } from "./errors";

/**
 * Guest list actions (0431). The database decides every move: review authority and
 * sod_guest_requester for decisions, Approved before Checked In, a decided guest keeps its guest. B8 (2974, 2975): the
 * pass fields (an Access category of the project, the host a project person, kept once checked in) and bulk emails.
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

const optionalId = z
  .string()
  .trim()
  .transform((v) => (v.length === 0 ? null : v))
  .pipe(z.uuid().nullable());

const passFields = z.object({
  passCategoryId: optionalId,
  hostPersonId: optionalId,
  tableLabel: z
    .string()
    .trim()
    .max(40)
    .transform((v) => (v.length === 0 ? null : v)),
  guestEmail: z
    .string()
    .trim()
    .toLowerCase()
    .max(320)
    .transform((v) => (v.length === 0 ? null : v))
    .pipe(z.email().nullable()),
});

function readPass(form: FormData) {
  const text = (key: string) => {
    const value = form.get(key);
    return typeof value === "string" ? value : "";
  };
  return {
    passCategoryId: text("passCategoryId"),
    hostPersonId: text("hostPersonId"),
    tableLabel: text("tableLabel"),
    guestEmail: text("guestEmail"),
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
  const pass = passFields.safeParse(readPass(form));
  if (!projectId.success) return { error: "invalid" };
  if (!guest.success) return fieldErrors(guest.error);
  if (!pass.success) return fieldErrors(pass.error);
  return done(
    ctx.org.slug,
    await addGuest(ctx.viewer.db, {
      orgId: ctx.org.id,
      projectId: projectId.data,
      approve: form.get("approve") === "true",
      ...guest.data,
      pass: pass.data as GuestPassInput,
    }),
  );
}

/** Sets a guest's pass type, table, host and email, in any state but Checked In (2974). */
export async function updateGuestPassAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const guestId = id.safeParse(form.get("guestId"));
  const pass = passFields.safeParse(readPass(form));
  if (!guestId.success) return { error: "invalid" };
  if (!pass.success) return fieldErrors(pass.error);
  return done(
    ctx.org.slug,
    await updateGuestPass(ctx.viewer.db, guestId.data, pass.data as GuestPassInput),
  );
}

export type GuestEmailState = AdvancingState & { readonly summary?: GuestEmailSummary };

/**
 * Queues an email to the chosen guests (app.queue_guest_emails, advancing.rider.write) and answers the send's counts:
 * queued, suppressed by the org's list, and skipped with the reason.
 */
export async function sendGuestEmailAction(
  _: GuestEmailState,
  form: FormData,
): Promise<GuestEmailState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      projectId: id,
      guestIds: z.array(id).min(1).max(500),
      kind: z.enum(["Invitation", "Pass", "Message"]),
      subject: z.string().trim().max(150),
      body: z.string().trim().max(5000),
      locale: z.enum(["en-US", "es-US"]),
    })
    .safeParse({
      projectId: form.get("projectId"),
      guestIds: form.getAll("guestId"),
      kind: form.get("kind"),
      subject: form.get("subject") ?? "",
      body: form.get("body") ?? "",
      locale: form.get("locale"),
    });
  if (!parsed.success) {
    return parsed.error.issues.some((i) => i.path[0] === "guestIds")
      ? { error: "guest_email_batch" }
      : { error: "guest_email_message" };
  }
  const { kind, subject, body } = parsed.data;
  if (kind === "Message" && (subject === "" || body === ""))
    return { error: "guest_email_message" };
  const queued = await queueGuestEmails(ctx.viewer.db, {
    projectId: parsed.data.projectId,
    guestIds: parsed.data.guestIds,
    kind,
    subject: kind === "Message" ? subject : null,
    body: body === "" ? null : body,
    locale: parsed.data.locale,
  });
  if (!queued.ok) return { error: errorKey(queued.error) };
  const summary = await guestEmailSendSummary(ctx.viewer.db, queued.data.sendId);
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return summary.ok ? { ok: true, summary: summary.data } : { ok: true };
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
