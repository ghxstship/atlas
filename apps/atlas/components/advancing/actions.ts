"use server";

import type { DataError, Result } from "@xos/data";
import {
  addRecipient,
  addRiderLine,
  addSection,
  addSectionChoice,
  ADVANCE_SECTION_KINDS,
  ADVANCE_WINDOW_KINDS,
  bookDockSlotFromAnswer,
  removeSectionChoice,
  sectionConfig,
  setRecipientNamesDue,
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
import { localToInstant } from "@/lib/operations/time";
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
  const parsed = z
    .object({
      packetId: id,
      title,
      prompt: optionalText(2000),
      kind: z.enum(ADVANCE_SECTION_KINDS).catch("Text"),
      windowKind: z.enum(ADVANCE_WINDOW_KINDS).nullable().catch(null),
      maxLines: z.coerce.number().int().nullable().catch(null),
      perPerson: z.boolean(),
      choices: z.array(z.string().regex(/^(asset_class|credential_category):[0-9a-f-]{36}$/)),
    })
    .safeParse({
      packetId: text(form, "packetId"),
      title: text(form, "title"),
      prompt: text(form, "prompt"),
      kind: text(form, "kind") || "Text",
      windowKind: text(form, "windowKind") || null,
      maxLines: text(form, "maxLines") || null,
      perPerson: text(form, "perPerson") === "on",
      choices: form.getAll("choice").filter((c): c is string => typeof c === "string" && c !== ""),
    });
  if (!parsed.success) {
    return {
      fieldErrors: {
        [parsed.error.issues[0]?.path[0] === "choices" ? "choices" : "title"]: "invalid",
      },
    };
  }
  const f = parsed.data;
  // R9: the kind and its configuration, held to the kind as advance_sections_kind_fields holds them.
  const config = sectionConfig({
    kind: f.kind,
    windowKind: f.windowKind,
    maxLines: f.maxLines,
    perPerson: f.perPerson,
  });
  if (config === null) return { fieldErrors: { maxLines: "maxLines" } };
  const needsChoices = f.kind === "Item Request" || f.kind === "Credential Request";
  if (needsChoices && f.choices.length === 0) return { fieldErrors: { choices: "choices" } };
  const added = await addSection(ctx.viewer.db, {
    orgId: ctx.org.id,
    packetId: f.packetId,
    title: f.title,
    prompt: f.prompt,
    config,
  });
  if (!added.ok || !needsChoices) return done(ctx.org.slug, added);
  for (const choice of f.choices) {
    const [kind, targetId] = choice.split(":") as ["asset_class" | "credential_category", string];
    const made = await addSectionChoice(ctx.viewer.db, {
      orgId: ctx.org.id,
      sectionId: added.data.id,
      target: { kind, id: targetId },
    });
    if (!made.ok) {
      // Leave no half-built section behind: the builder adds it again with its choices.
      await removeSection(ctx.viewer.db, added.data.id);
      return done(ctx.org.slug, made);
    }
  }
  return done(ctx.org.slug, added);
}

/** Removes one choice from a draft Item Request or Credential Request section (R9). */
export async function removeSectionChoiceAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const choiceId = id.safeParse(text(form, "choiceId"));
  if (!choiceId.success) return { error: "invalid" };
  return done(ctx.org.slug, await removeSectionChoice(ctx.viewer.db, choiceId.data));
}

/** Adds one choice to a draft Item Request or Credential Request section (R9). */
export async function addSectionChoiceAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const [kind, targetId] = text(form, "choice").split(":");
  const parsed = z
    .object({ sectionId: id, kind: z.enum(["asset_class", "credential_category"]), targetId: id })
    .safeParse({ sectionId: text(form, "sectionId"), kind, targetId });
  if (!parsed.success) return { fieldErrors: { choice: "choice" } };
  return done(
    ctx.org.slug,
    await addSectionChoice(ctx.viewer.db, {
      orgId: ctx.org.id,
      sectionId: parsed.data.sectionId,
      target: { kind: parsed.data.kind, id: parsed.data.targetId },
    }),
  );
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
    .object({
      packetId: id,
      kind: z.enum(["person", "counterparty"]),
      partyId: id,
      engagementId: id.nullable(),
      timeZone: z.string().trim().min(1).max(64),
    })
    .safeParse({
      packetId: text(form, "packetId"),
      kind,
      partyId,
      engagementId: text(form, "engagementId") || null,
      timeZone: text(form, "timeZone") || "UTC",
    });
  if (!parsed.success) return { fieldErrors: { party: "party" } };
  // R9: the engagement the recipient answers under, and its naming deadline in the project's zone (G-141).
  const local = parsed.data.engagementId ? text(form, "namesDueAt") : "";
  const namesDue = local === "" ? null : localToInstant(local, parsed.data.timeZone);
  if (local !== "" && namesDue === null) return { fieldErrors: { namesDueAt: "namesDueAt" } };
  return done(
    ctx.org.slug,
    await addRecipient(ctx.viewer.db, {
      orgId: ctx.org.id,
      packetId: parsed.data.packetId,
      party: { kind: parsed.data.kind, id: parsed.data.partyId },
      engagementId: parsed.data.engagementId,
      namesDueAt: namesDue,
    }),
  );
}

/** Sets or clears a recipient's naming deadline, in the project's zone (G-141, migration 2716). */
export async function setNamesDueAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ recipientId: id, timeZone: z.string().trim().min(1).max(64) })
    .safeParse({
      recipientId: text(form, "recipientId"),
      timeZone: text(form, "timeZone") || "UTC",
    });
  if (!parsed.success) return { error: "invalid" };
  const local = text(form, "namesDueAt");
  const at = local === "" ? null : localToInstant(local, parsed.data.timeZone);
  if (local !== "" && at === null) return { fieldErrors: { namesDueAt: "namesDueAt" } };
  return done(ctx.org.slug, await setRecipientNamesDue(ctx.viewer.db, parsed.data.recipientId, at));
}

/** Books an Accepted Load In or Load Out window as a dock slot (app.book_dock_slot_from_answer, R9). */
export async function bookDockSlotAction(
  _: AdvancingState,
  form: FormData,
): Promise<AdvancingState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ lineId: id, zoneId: id })
    .safeParse({ lineId: text(form, "lineId"), zoneId: text(form, "zoneId") });
  if (!parsed.success) return { fieldErrors: { zoneId: "zoneId" } };
  return done(ctx.org.slug, await bookDockSlotFromAnswer(ctx.viewer.db, parsed.data));
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
