"use server";

import type { DataError } from "@xos/data";
import {
  addAvailabilityPeriod,
  createShiftTemplate,
  createShiftsFromTemplate,
  daysBetween,
  ensureMemberAvailabilityCalendar,
  rankShiftCandidates,
  removeAvailabilityPeriod,
  trashShiftTemplate,
  updateShift,
  type AvailabilityKind,
  type ShiftCandidate,
} from "@xos/data/crew";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import type { CrewActionState } from "@/lib/crew/action-state";
import { errorMessage } from "@/lib/crew/errors";
import { zonedToIso } from "@/lib/crew/time";
import { getOrgContext } from "@/lib/shell/context";
import { getTranslate, type Translate } from "@/lib/shell/translate";

/**
 * Crew scheduling actions (A132, migrations 2250 and 2251, ADR 0063): plan shifts from a template, put a ranked
 * member on a shift from the schedule's drag list, keep the org's shift templates (Settings, Scheduling) and state
 * one's own availability (Me, Work details). Each resolves the viewer's org context again (404 when it is gone) and
 * writes as the viewer, so row level security, the RPCs and the notice lock decide.
 */

type State = CrewActionState;

const uuid = z.uuid();
const isoDate = z.iso.date();
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

async function context(slug: unknown) {
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return { ctx, db: ctx.viewer.db, t: await getTranslate() };
}

function invalid(t: Translate, fields: Record<string, string>): State {
  return {
    error: t("crew.errors.fixFields"),
    fieldErrors: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, t(v)])),
  };
}

function failed(t: Translate, error: DataError): State {
  return {
    error: errorMessage(t, error),
    ...(error.kind === "refusal" ? { rule: error.rule } : {}),
  };
}

function refresh(slug: string) {
  revalidatePath(`/${slug}/crew`, "layout");
  revalidatePath(`/${slug}/p`, "layout");
}

// Planning from a template ---------------------------------------------------------------------------------

/** Plans the template's shifts on every day from `from` to `to` (Crew > Schedule, "Plan from template"). */
export async function createShiftsFromTemplateAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form.get("org"));
  const parsed = z
    .object({ templateId: uuid, projectId: uuid, from: isoDate, to: isoDate })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]);
      fields[key] =
        key === "templateId"
          ? "crew.scheduling.errors.template"
          : key === "projectId"
            ? "crew.errors.project"
            : "crew.errors.date";
    }
    return invalid(t, fields);
  }
  const days = daysBetween(parsed.data.from, parsed.data.to);
  if (days.length === 0) return invalid(t, { to: "crew.scheduling.errors.toAfterFrom" });
  if (days.length > 31) return invalid(t, { to: "crew.scheduling.errors.tooManyDays" });
  const result = await createShiftsFromTemplate(db, {
    templateId: parsed.data.templateId,
    projectId: parsed.data.projectId,
    days,
  });
  if (!result.ok) return failed(t, result.error);
  refresh(ctx.org.slug);
  return { ok: true };
}

// The drag list --------------------------------------------------------------------------------------------

export type CandidatesResult =
  | { readonly ok: true; readonly candidates: readonly ShiftCandidate[] }
  | { readonly ok: false; readonly error: string };

/** The org's members ranked for one shift, for the schedule's drag list. */
export async function rankCandidatesAction(
  org: string,
  shiftId: string,
  weekStart: string,
): Promise<CandidatesResult> {
  const { db, t } = await context(org);
  if (!uuid.safeParse(shiftId).success) return { ok: false, error: t("crew.errors.notFound") };
  const ranked = await rankShiftCandidates(
    db,
    shiftId,
    isoDate.safeParse(weekStart).success ? weekStart : undefined,
  );
  if (!ranked.ok) return { ok: false, error: errorMessage(t, ranked.error) };
  return { ok: true, candidates: ranked.data };
}

/** Puts a member on an open shift, dropped from the ranked list or assigned from the keyboard. */
export async function assignShiftAction(
  org: string,
  shiftId: string,
  membershipId: string,
): Promise<State> {
  const { ctx, db, t } = await context(org);
  if (!uuid.safeParse(shiftId).success || !uuid.safeParse(membershipId).success) {
    return { error: t("crew.errors.notFound") };
  }
  const result = await updateShift(db, shiftId, { membershipId });
  if (!result.ok) return failed(t, result.error);
  refresh(ctx.org.slug);
  return { ok: true };
}

// Shift templates (Settings, Scheduling) ---------------------------------------------------------------------

export async function createShiftTemplateAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form.get("org"));
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(120),
      roleCode: z.string(),
      callTime: clock,
      wrapTime: clock,
      headcount: z.coerce.number().int().min(1).max(50),
      breakMinutes: z.coerce.number().int().min(0).max(1440),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0]);
      fields[key] = `crew.scheduling.templates.errors.${key}`;
    }
    return invalid(t, fields);
  }
  const p = parsed.data;
  if (p.callTime === p.wrapTime) {
    return invalid(t, { wrapTime: "crew.scheduling.templates.errors.wrapTime" });
  }
  const result = await createShiftTemplate(db, {
    orgId: ctx.org.id,
    name: p.name,
    roleCode: p.roleCode === "" ? null : p.roleCode,
    callTime: p.callTime,
    wrapTime: p.wrapTime,
    headcount: p.headcount,
    breakMinutes: p.breakMinutes,
  });
  if (!result.ok) {
    if (result.error.kind === "conflict") {
      return invalid(t, { name: "crew.scheduling.templates.errors.duplicate" });
    }
    if (result.error.kind === "invalid") {
      return invalid(t, { breakMinutes: "crew.scheduling.templates.errors.breakMinutes" });
    }
    return failed(t, result.error);
  }
  revalidatePath(`/${ctx.org.slug}/settings/scheduling`);
  refresh(ctx.org.slug);
  return { ok: true };
}

export async function trashShiftTemplateAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form.get("org"));
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return { error: t("crew.errors.notFound") };
  const result = await trashShiftTemplate(db, id.data);
  if (!result.ok) return failed(t, result.error);
  revalidatePath(`/${ctx.org.slug}/settings/scheduling`);
  refresh(ctx.org.slug);
  return { ok: true };
}

// One's own availability (Me, Work details) ------------------------------------------------------------------

const KIND = z.enum(["Available", "Unavailable", "Tentative"]);

export async function addAvailabilityAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form.get("org"));
  const zone = typeof form.get("timeZone") === "string" ? String(form.get("timeZone")) : "";
  const kind = KIND.safeParse(form.get("kind"));
  const startsAt = zonedToIso(String(form.get("startsAt") ?? ""), zone);
  const endsAt = zonedToIso(String(form.get("endsAt") ?? ""), zone);
  const errors: Record<string, string> = {};
  if (!kind.success) errors["kind"] = "crew.scheduling.availability.errors.kind";
  if (!startsAt) errors["startsAt"] = "crew.errors.dateTime";
  if (!endsAt) errors["endsAt"] = "crew.errors.dateTime";
  if (startsAt && endsAt && endsAt <= startsAt) errors["endsAt"] = "crew.errors.endAfterStart";
  if (Object.keys(errors).length > 0 || !kind.success || !startsAt || !endsAt) {
    return invalid(t, errors);
  }
  const calendar = await ensureMemberAvailabilityCalendar(db, ctx.org.id, zone || null);
  if (!calendar.ok) return failed(t, calendar.error);
  const result = await addAvailabilityPeriod(db, {
    calendarId: calendar.data.id,
    startsAt,
    endsAt,
    kind: kind.data as AvailabilityKind,
  });
  if (!result.ok) return failed(t, result.error);
  revalidatePath(`/${ctx.org.slug}/me/work-details`);
  return { ok: true };
}

export async function removeAvailabilityAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form.get("org"));
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return { error: t("crew.errors.notFound") };
  const result = await removeAvailabilityPeriod(db, id.data);
  if (!result.ok) return failed(t, result.error);
  revalidatePath(`/${ctx.org.slug}/me/work-details`);
  return { ok: true };
}
