"use server";

import {
  addIncidentMedia,
  addIncidentParty,
  addMedicalEncounter,
  archiveRadioChannel,
  closeIncident,
  createRadioChannel,
  dispatchResponder,
  endCrisisAlert,
  importStandardRadioPlan,
  issueCrisisAlert,
  markArrived,
  removeIncidentMedia,
  removeIncidentParty,
  reportIncident,
  transitionIncident,
  updateEmergencyCode,
  updateIncident,
  updateRadioChannel,
  withdrawResponder,
} from "@xos/data/incidents";
import { myModuleCapabilities } from "@xos/data/credentials";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import { getOrgContext } from "@/lib/shell/context";
import { failed, type ActionState } from "@/lib/operations/state";
import { localToInstant } from "@/lib/operations/time";
import * as enums from "@xos/data/enums";

/**
 * Safety incident actions (Section 4.2): report, edit, dispatch, contain, close with sign-off,
 * parties, media, responders, medical encounters, crisis alerts, the org's emergency codes and the
 * radio plan. Each resolves the org context again (404 when gone), validates input and calls the
 * repository; the RPCs and row level security of migrations 0353, 0363, 0470, 0471 and 1612 decide
 * every write.
 */

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

function text(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function done(slug: string, result?: Record<string, string>): ActionState {
  revalidatePath(`/${slug}`, "layout");
  return result ? { ok: true, result } : { ok: true };
}

const TimeZone = z.string().refine((zone) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
});

const IncidentFields = z.object({
  title: z.string().trim().min(1).max(200),
  severityId: z.string().min(1).max(40),
  zoneId: z.uuid().optional(),
  occurredAt: z.string(),
  timeZone: TimeZone,
});

function incidentInput(form: FormData) {
  return {
    title: form.get("title"),
    severityId: form.get("severityId"),
    zoneId: text(form, "zoneId"),
    occurredAt: form.get("occurredAt"),
    timeZone: form.get("timeZone"),
  };
}

export async function reportIncidentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = IncidentFields.extend({ projectId: z.uuid() }).safeParse({
    ...incidentInput(form),
    projectId: form.get("projectId"),
  });
  if (!parsed.success) return { error: "incidentInput" };
  const occurredAt = localToInstant(parsed.data.occurredAt, parsed.data.timeZone);
  if (!occurredAt || new Date(occurredAt) > new Date(Date.now() + 5 * 60_000)) {
    return { error: "occurredAt" };
  }
  const result = await reportIncident(ctx.viewer.db, {
    orgId: ctx.org.id,
    projectId: parsed.data.projectId,
    title: parsed.data.title,
    severityId: parsed.data.severityId,
    occurredAt,
    zoneId: parsed.data.zoneId ?? null,
  });
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug, { number: String(result.data.incidentNumber) });
}

export async function updateIncidentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = IncidentFields.extend({ id: z.uuid() }).safeParse({
    ...incidentInput(form),
    id: form.get("id"),
  });
  if (!parsed.success) return { error: "incidentInput" };
  const occurredAt = localToInstant(parsed.data.occurredAt, parsed.data.timeZone);
  if (!occurredAt) return { error: "occurredAt" };
  const result = await updateIncident(ctx.viewer.db, parsed.data.id, {
    title: parsed.data.title,
    severityId: parsed.data.severityId,
    zoneId: parsed.data.zoneId ?? null,
    occurredAt,
  });
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

const States = z.enum(enums.incidentState);

export async function transitionIncidentAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      id: z.uuid(),
      expected: States,
      next: z.enum(["Dispatched", "Contained"]),
      reason: z.string().trim().min(1).max(500),
    })
    .safeParse({
      id: form.get("id"),
      expected: form.get("expected"),
      next: form.get("next"),
      reason: form.get("reason"),
    });
  if (!parsed.success) return { error: "reasonInput" };
  const result = await transitionIncident(ctx.viewer.db, parsed.data);
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

export async function closeIncidentAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ id: z.uuid(), note: z.string().trim().min(1).max(500) })
    .safeParse({ id: form.get("id"), note: form.get("note") });
  if (!parsed.success) return { error: "signoffInput" };
  const result = await closeIncident(ctx.viewer.db, parsed.data.id, parsed.data.note);
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

export async function addPartyAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      incidentId: z.uuid(),
      personId: z.uuid().optional(),
      description: z.string().trim().min(1).max(500),
    })
    .safeParse({
      incidentId: form.get("incidentId"),
      personId: text(form, "personId"),
      description: form.get("description"),
    });
  if (!parsed.success) return { error: "partyInput" };
  const result = await addIncidentParty(ctx.viewer.db, {
    orgId: ctx.org.id,
    incidentId: parsed.data.incidentId,
    personId: parsed.data.personId ?? null,
    description: parsed.data.description,
  });
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

export async function removePartyAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "notFound" };
  const result = await removeIncidentParty(ctx.viewer.db, id.data);
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

export async function addMediaAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ incidentId: z.uuid(), mediaUri: z.string().trim().min(1).max(1000) })
    .safeParse({ incidentId: form.get("incidentId"), mediaUri: form.get("mediaUri") });
  if (!parsed.success) return { error: "mediaInput" };
  const result = await addIncidentMedia(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

export async function removeMediaAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "notFound" };
  const result = await removeIncidentMedia(ctx.viewer.db, id.data);
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

export async function dispatchAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ incidentId: z.uuid(), membershipId: z.uuid() })
    .safeParse({ incidentId: form.get("incidentId"), membershipId: form.get("membershipId") });
  if (!parsed.success) return { error: "dispatchInput" };
  const result = await dispatchResponder(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

export async function arrivedAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "notFound" };
  const result = await markArrived(ctx.viewer.db, id.data);
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

export async function withdrawAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "notFound" };
  const result = await withdrawResponder(ctx.viewer.db, id.data);
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

/**
 * Records a medical encounter. Writing Restricted medical notes needs both safety.incident.write
 * (checked by app.record_medical_encounter) and data.restricted.read.medical on the project,
 * checked here until the database checks it too (reported to A03F).
 */
export async function addEncounterAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      incidentId: z.uuid(),
      projectId: z.uuid(),
      patientDescription: z.string().trim().min(1).max(500),
      treatmentNotes: z.string().trim().max(4000).optional(),
      disposition: z.string().trim().max(200).optional(),
    })
    .safeParse({
      incidentId: form.get("incidentId"),
      projectId: form.get("projectId"),
      patientDescription: form.get("patientDescription"),
      treatmentNotes: text(form, "treatmentNotes"),
      disposition: text(form, "disposition"),
    });
  if (!parsed.success) return { error: "encounterInput" };
  const caps = await myModuleCapabilities(ctx.viewer.db, parsed.data.projectId);
  if (!caps.ok) return failed(caps.error);
  if (!caps.data.has("data.restricted.read.medical")) {
    return { error: "rules.medical_capability_required" };
  }
  const result = await addMedicalEncounter(ctx.viewer.db, {
    orgId: ctx.org.id,
    incidentId: parsed.data.incidentId,
    patientDescription: parsed.data.patientDescription,
    treatmentNotes: parsed.data.treatmentNotes ?? null,
    disposition: parsed.data.disposition ?? null,
  });
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

// Crisis alerts -----------------------------------------------------------------------------------

export async function issueAlertAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      projectId: z.uuid(),
      emergencyCode: z.string().regex(/^CODE_[A-Z]+$/),
      message: z.string().trim().min(1).max(1000),
    })
    .safeParse({
      projectId: form.get("projectId"),
      emergencyCode: form.get("emergencyCode"),
      message: form.get("message"),
    });
  if (!parsed.success) return { error: "alertInput" };
  const result = await issueCrisisAlert(ctx.viewer.db, { orgId: ctx.org.id, ...parsed.data });
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

export async function endAlertAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "notFound" };
  const result = await endCrisisAlert(ctx.viewer.db, id.data);
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

// Radio plan --------------------------------------------------------------------------------------

const Channel = z.object({
  channelNumber: z.coerce.number().int().min(1).max(9999),
  name: z.string().trim().min(1).max(200),
  zoneId: z.uuid().optional(),
});

function channelInput(form: FormData) {
  return {
    channelNumber: form.get("channelNumber"),
    name: form.get("name"),
    zoneId: text(form, "zoneId"),
  };
}

export async function createChannelAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = Channel.extend({ projectId: z.uuid() }).safeParse({
    ...channelInput(form),
    projectId: form.get("projectId"),
  });
  if (!parsed.success) return { error: "channelInput" };
  const result = await createRadioChannel(ctx.viewer.db, {
    orgId: ctx.org.id,
    projectId: parsed.data.projectId,
    channelNumber: parsed.data.channelNumber,
    name: parsed.data.name,
    zoneId: parsed.data.zoneId ?? null,
  });
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug, { channel: String(parsed.data.channelNumber) });
}

export async function updateChannelAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = Channel.extend({ id: z.uuid() }).safeParse({
    ...channelInput(form),
    id: form.get("id"),
  });
  if (!parsed.success) return { error: "channelInput" };
  const result = await updateRadioChannel(ctx.viewer.db, parsed.data.id, {
    channelNumber: parsed.data.channelNumber,
    name: parsed.data.name,
    zoneId: parsed.data.zoneId ?? null,
  });
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

export async function archiveChannelAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: "notFound" };
  const result = await archiveRadioChannel(ctx.viewer.db, id.data);
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

/** Relabels, redescribes or reorders the org's copy of an emergency code (migration 1612). */
export async function updateEmergencyCodeAction(
  _: ActionState,
  form: FormData,
): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      id: z.uuid(),
      label: z.string().trim().min(1).max(100),
      emergency: z.string().trim().min(1).max(200),
      sortOrder: z.coerce.number().int().min(1).max(999),
    })
    .safeParse({
      id: form.get("id"),
      label: form.get("label"),
      emergency: form.get("emergency"),
      sortOrder: form.get("sortOrder"),
    });
  if (!parsed.success) return { error: "emergencyCodeInput" };
  const result = await updateEmergencyCode(ctx.viewer.db, parsed.data.id, parsed.data);
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug);
}

export async function importPlanAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ projectId: z.uuid(), libraryZone: z.coerce.number().int().min(1).max(99) })
    .safeParse({ projectId: form.get("projectId"), libraryZone: form.get("libraryZone") });
  if (!parsed.success) return { error: "channelInput" };
  const result = await importStandardRadioPlan(ctx.viewer.db, {
    orgId: ctx.org.id,
    ...parsed.data,
  });
  if (!result.ok) return failed(result.error);
  return done(ctx.org.slug, { count: String(result.data.added) });
}
