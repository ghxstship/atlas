"use server";

import type { DataError, Result } from "@xos/data";
import {
  addRecipient,
  addRiderLine,
  addSection,
  archivePacket,
  archiveRider,
  createPacket,
  createRider,
  issueAdvanceLink,
  moveSection,
  recordSubmission,
  removeRecipient,
  removeRiderLine,
  removeSection,
  revokeAdvanceLink,
  reviewSubmission,
  runReconciliation,
  sendPacket,
  setRiderLineFulfilled,
  updatePacket,
  updateRider,
  updateRiderLine,
  updateSection,
} from "@xos/data/advancing";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { gatewayUrl } from "@/lib/gateway-url";
import { getOrgContext } from "@/lib/shell/context";
import { KNOWN_ERRORS } from "./errors";

/**
 * Advancing actions. Each resolves the viewer's org context again (404 when it is gone), validates
 * the form with Zod and calls the repository; row level security, the 0430 guards and RPCs decide
 * every write. Outcomes come back as catalog keys under `advancing.errors`, never as raw messages.
 */

export interface AdvancingState {
  readonly ok?: boolean;
  readonly error?: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  /** The id of a row the action created, for navigation to it. */
  readonly id?: string;
  /** A link issued once: shown to the issuer, never stored in clear. */
  readonly issued?: {
    readonly token: string;
    readonly accessCode: string;
    readonly expiresAt: string;
    /** The full Gateway URL of the advance link (GATEWAY_SITE_URL), or its path without one. */
    readonly url: string;
  };
}

function errorKey(error: DataError): string {
  if (error.kind === "refusal") return KNOWN_ERRORS.has(error.rule) ? error.rule : "refused";
  return error.kind;
}

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

function done<T>(slug: string, result: Result<T>, extra?: (data: T) => AdvancingState) {
  if (!result.ok) return { error: errorKey(result.error) } satisfies AdvancingState;
  revalidatePath(`/${slug}`, "layout");
  return { ok: true, ...(extra ? extra(result.data) : {}) } satisfies AdvancingState;
}

const id = z.uuid();
const title = z.string().trim().min(1).max(200);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v.length === 0 ? null : v));
/** A `datetime-local` value read in the viewer's time zone offset sent with the form. */
const dueAt = z
  .string()
  .trim()
  .transform((v, issue) => {
    if (v.length === 0) return null;
    const date = new Date(v);
    if (Number.isNaN(date.getTime())) {
      issue.addIssue({ code: "custom", message: "dueAt" });
      return z.NEVER;
    }
    return date.toISOString();
  });

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

/** The `datetime-local` value plus the browser's offset, so the server reads the viewer's time. */
function localDateTime(form: FormData, key: string): string {
  const value = text(form, key);
  const offset = text(form, "tzOffset");
  if (!value || !/^[+-]\d{2}:\d{2}$/.test(offset)) return value;
  return `${/T\d{2}:\d{2}$/.test(value) ? `${value}:00` : value}${offset}`;
}

// Packets -------------------------------------------------------------------------------------------

export async function createPacketAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const parsed = z.object({ projectId: id, title, dueAt }).safeParse({
    projectId: text(form, "projectId"),
    title: text(form, "title"),
    dueAt: localDateTime(form, "dueAt"),
  });
  if (!parsed.success) {
    const fields = new Set(parsed.error.issues.map((i) => String(i.path[0])));
    return {
      fieldErrors: Object.fromEntries([...fields].map((f) => [f, f])),
    };
  }
  const result = await createPacket(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  return done(ctx.org.slug, result, (data) => ({ id: data.id }));
}

export async function updatePacketAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const parsed = z.object({ packetId: id, title, dueAt }).safeParse({
    packetId: text(form, "packetId"),
    title: text(form, "title"),
    dueAt: localDateTime(form, "dueAt"),
  });
  if (!parsed.success) return { fieldErrors: { title: "title" } };
  return done(
    ctx.org.slug,
    await updatePacket(ctx.viewer.db, parsed.data.packetId, {
      title: parsed.data.title,
      dueAt: parsed.data.dueAt,
    }),
  );
}

export async function archivePacketAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const packetId = id.safeParse(text(form, "packetId"));
  if (!packetId.success) return { error: "invalid" };
  return done(ctx.org.slug, await archivePacket(ctx.viewer.db, packetId.data));
}

export async function sendPacketAction(_: AdvancingState, form: FormData): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const packetId = id.safeParse(text(form, "packetId"));
  if (!packetId.success) return { error: "invalid" };
  return done(ctx.org.slug, await sendPacket(ctx.viewer.db, packetId.data));
}

// Sections ------------------------------------------------------------------------------------------

export async function addSectionAction(_: AdvancingState, form: FormData): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const parsed = z.object({ packetId: id, title, prompt: optionalText(2000) }).safeParse({
    packetId: text(form, "packetId"),
    title: text(form, "title"),
    prompt: text(form, "prompt"),
  });
  if (!parsed.success) return { fieldErrors: { title: "title" } };
  return done(ctx.org.slug, await addSection(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data }));
}

export async function updateSectionAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const parsed = z.object({ sectionId: id, title, prompt: optionalText(2000) }).safeParse({
    sectionId: text(form, "sectionId"),
    title: text(form, "title"),
    prompt: text(form, "prompt"),
  });
  if (!parsed.success) return { fieldErrors: { title: "title" } };
  return done(
    ctx.org.slug,
    await updateSection(ctx.viewer.db, parsed.data.sectionId, {
      title: parsed.data.title,
      prompt: parsed.data.prompt,
    }),
  );
}

export async function removeSectionAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const sectionId = id.safeParse(text(form, "sectionId"));
  if (!sectionId.success) return { error: "invalid" };
  return done(ctx.org.slug, await removeSection(ctx.viewer.db, sectionId.data));
}

export async function moveSectionAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ packetId: id, sectionId: id, direction: z.enum(["up", "down"]) })
    .safeParse({
      packetId: text(form, "packetId"),
      sectionId: text(form, "sectionId"),
      direction: text(form, "direction"),
    });
  if (!parsed.success) return { error: "invalid" };
  return done(ctx.org.slug, await moveSection(ctx.viewer.db, parsed.data));
}

// Recipients and links ------------------------------------------------------------------------------

export async function addRecipientAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const [kind, partyId] = text(form, "party").split(":");
  const parsed = z
    .object({ packetId: id, kind: z.enum(["person", "counterparty"]), partyId: id })
    .safeParse({ packetId: text(form, "packetId"), kind, partyId });
  if (!parsed.success) return { fieldErrors: { party: "party" } };
  return done(
    ctx.org.slug,
    await addRecipient(ctx.viewer.db, {
      orgId: ctx.org.id,
      packetId: parsed.data.packetId,
      party: { kind: parsed.data.kind, id: parsed.data.partyId },
    }),
  );
}

export async function removeRecipientAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const recipientId = id.safeParse(text(form, "recipientId"));
  if (!recipientId.success) return { error: "invalid" };
  return done(ctx.org.slug, await removeRecipient(ctx.viewer.db, recipientId.data));
}

export async function issueLinkAction(_: AdvancingState, form: FormData): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      recipientId: id,
      email: z.email().max(320),
      validDays: z.coerce.number().int().min(1).max(90),
    })
    .safeParse({
      recipientId: text(form, "recipientId"),
      email: text(form, "email").trim(),
      validDays: text(form, "validDays"),
    });
  if (!parsed.success) {
    const fields = new Set(parsed.error.issues.map((i) => String(i.path[0])));
    return { fieldErrors: Object.fromEntries([...fields].map((f) => [f, f])) };
  }
  return done(ctx.org.slug, await issueAdvanceLink(ctx.viewer.db, parsed.data), (link) => ({
    issued: {
      token: link.token,
      accessCode: link.accessCode,
      expiresAt: link.expiresAt,
      url: gatewayUrl(`/advance/${link.token}`),
    },
  }));
}

export async function revokeLinkAction(_: AdvancingState, form: FormData): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const linkId = id.safeParse(text(form, "linkId"));
  if (!linkId.success) return { error: "invalid" };
  return done(ctx.org.slug, await revokeAdvanceLink(ctx.viewer.db, linkId.data));
}

// Submissions ---------------------------------------------------------------------------------------

export async function recordSubmissionAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ sectionId: id, recipientId: id, body: z.string().trim().min(1).max(20000) })
    .safeParse({
      sectionId: text(form, "sectionId"),
      recipientId: text(form, "recipientId"),
      body: text(form, "body"),
    });
  if (!parsed.success) {
    const fields = new Set(parsed.error.issues.map((i) => String(i.path[0])));
    return { fieldErrors: Object.fromEntries([...fields].map((f) => [f, f])) };
  }
  return done(
    ctx.org.slug,
    await recordSubmission(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data }),
  );
}

export async function reviewSubmissionAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const person = ctx.viewer.person;
  if (!person) notFound();
  const parsed = z
    .object({
      submissionId: id,
      outcome: z.enum(["Accepted", "Returned"]),
      returnReason: optionalText(1000),
    })
    .refine((v) => v.outcome === "Accepted" || v.returnReason !== null, {
      path: ["returnReason"],
    })
    .safeParse({
      submissionId: text(form, "submissionId"),
      outcome: text(form, "outcome"),
      returnReason: text(form, "returnReason"),
    });
  if (!parsed.success) return { fieldErrors: { returnReason: "returnReason" } };
  return done(
    ctx.org.slug,
    await reviewSubmission(ctx.viewer.db, { ...parsed.data, reviewerPersonId: person.id }),
  );
}

// Riders --------------------------------------------------------------------------------------------

/**
 * Whose rider it is (R2): nobody (""), a counterparty ("c:<id>") or an individual artist's
 * engagement ("e:<id>"), so a rider never names both.
 */
const party = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (v.length === 0) return { counterpartyId: null, engagementId: null };
    const [kind, value] = [v.slice(0, 2), v.slice(2)];
    if (!z.uuid().safeParse(value).success || (kind !== "c:" && kind !== "e:")) {
      ctx.addIssue({ code: "custom", message: "party" });
      return z.NEVER;
    }
    return kind === "c:"
      ? { counterpartyId: value, engagementId: null }
      : { counterpartyId: null, engagementId: value };
  });

export async function createRiderAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const parsed = z.object({ projectId: id, title, party }).safeParse({
    projectId: text(form, "projectId"),
    title: text(form, "title"),
    party: text(form, "party"),
  });
  if (!parsed.success) {
    const fields = new Set(parsed.error.issues.map((i) => String(i.path[0])));
    return { fieldErrors: Object.fromEntries([...fields].map((f) => [f, f])) };
  }
  return done(
    ctx.org.slug,
    await createRider(ctx.viewer.db, {
      orgId: ctx.org.id,
      projectId: parsed.data.projectId,
      title: parsed.data.title,
      ...parsed.data.party,
    }),
    (data) => ({ id: data.id }),
  );
}

export async function updateRiderAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const parsed = z.object({ riderId: id, title, party }).safeParse({
    riderId: text(form, "riderId"),
    title: text(form, "title"),
    party: text(form, "party"),
  });
  if (!parsed.success) {
    const fields = new Set(parsed.error.issues.map((i) => String(i.path[0])));
    return { fieldErrors: Object.fromEntries([...fields].map((f) => [f, f])) };
  }
  return done(
    ctx.org.slug,
    await updateRider(ctx.viewer.db, parsed.data.riderId, {
      title: parsed.data.title,
      ...parsed.data.party,
    }),
  );
}

export async function archiveRiderAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const riderId = id.safeParse(text(form, "riderId"));
  if (!riderId.success) return { error: "invalid" };
  return done(ctx.org.slug, await archiveRider(ctx.viewer.db, riderId.data));
}

/** A quantity field: blank stays blank (null), never zero (Section 3.7). */
const quantity = z
  .string()
  .trim()
  .transform((v) => (v.length === 0 ? null : Number(v)))
  .pipe(z.number().nonnegative().finite().nullable());

const riderLine = z.object({
  description: z.string().trim().min(1).max(500),
  elementId: optionalText(64),
  quantity,
});

function lineFields(form: FormData) {
  return {
    description: text(form, "description"),
    elementId: text(form, "elementId"),
    quantity: text(form, "quantity"),
  };
}

export async function addRiderLineAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const riderId = id.safeParse(text(form, "riderId"));
  const line = riderLine.safeParse(lineFields(form));
  if (!riderId.success) return { error: "invalid" };
  if (!line.success) {
    const fields = new Set(line.error.issues.map((i) => String(i.path[0])));
    return { fieldErrors: Object.fromEntries([...fields].map((f) => [f, f])) };
  }
  return done(
    ctx.org.slug,
    await addRiderLine(ctx.viewer.db, {
      orgId: ctx.org.id,
      riderId: riderId.data,
      line: line.data,
    }),
  );
}

export async function updateRiderLineAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const lineId = id.safeParse(text(form, "lineId"));
  const line = riderLine.safeParse(lineFields(form));
  if (!lineId.success) return { error: "invalid" };
  if (!line.success) {
    const fields = new Set(line.error.issues.map((i) => String(i.path[0])));
    return { fieldErrors: Object.fromEntries([...fields].map((f) => [f, f])) };
  }
  return done(ctx.org.slug, await updateRiderLine(ctx.viewer.db, lineId.data, line.data));
}

export async function toggleRiderLineAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const lineId = id.safeParse(text(form, "lineId"));
  if (!lineId.success) return { error: "invalid" };
  return done(
    ctx.org.slug,
    await setRiderLineFulfilled(ctx.viewer.db, lineId.data, text(form, "fulfilled") === "true"),
  );
}

export async function removeRiderLineAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const lineId = id.safeParse(text(form, "lineId"));
  if (!lineId.success) return { error: "invalid" };
  return done(ctx.org.slug, await removeRiderLine(ctx.viewer.db, lineId.data));
}

// Reconciliation ------------------------------------------------------------------------------------

export async function runReconciliationAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ projectId: id, note: optionalText(1000) })
    .safeParse({ projectId: text(form, "projectId"), note: text(form, "note") });
  if (!parsed.success) return { fieldErrors: { projectId: "projectId" } };
  return done(ctx.org.slug, await runReconciliation(ctx.viewer.db, parsed.data), (data) => ({
    id: data.id,
  }));
}
