"use server";

import type { DataError, Result } from "@xos/data";
import {
  acceptShift,
  acceptSwap,
  awardOpenShift,
  decideShiftClaim,
  withdrawShiftClaim,
  addRateCardLine,
  approvePayrollRun,
  calculatePayrollRun,
  cancelSwap,
  cancelTimeOff,
  claimOpenShift,
  clockIn,
  clockOut,
  createPayPeriod,
  createPayrollRun,
  createRateCard,
  createShift,
  createTimeEntry,
  createTimesheet,
  decideCorrection,
  decideSwap,
  decideTimeOff,
  decideTimesheet,
  payrollExportFile,
  producePayrollExport,
  publishShifts,
  recordPayRate,
  removeRateCardLine,
  requestCorrection,
  requestSwap,
  requestTimeOff,
  submitTimesheet,
  transitionPayPeriod,
  transitionPayrollRun,
  transitionShift,
  trashRateCard,
  trashShift,
  updatePayPeriod,
  updateRateCard,
  updateRateCardLine,
  updateShift,
  updateTimeEntry,
  voidTimeEntry,
  type PayPeriodState,
  type PayrollRunState,
  type ShiftState,
  type TimeOffState,
} from "@xos/data/crew";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import type { CrewActionState } from "@/lib/crew/action-state";
import { errorMessage } from "@/lib/crew/errors";
import { toMinor } from "@/lib/crew/money";
import { zonedToIso } from "@/lib/crew/time";
import { getOrgContext } from "@/lib/shell/context";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import { planHasFeature } from "@/lib/crew/plan";

/**
 * Crew server actions. Each resolves the viewer's org context again (404 when it is gone), validates
 * the form, and calls the Crew repository; row level security, the guards and the RPCs of migrations
 * 0340, 0341, 0460 and 0461 decide every write. Refusals come back as sentences in the viewer's
 * language, naming the rule and the next action.
 */

type State = CrewActionState;

async function context(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return { ctx, db: ctx.viewer.db, t: await getTranslate() };
}

function done(slug: string, result: Result<unknown>, t: Translate): State {
  if (!result.ok) return { error: errorMessage(t, result.error) };
  revalidatePath(`/${slug}/crew`, "layout");
  revalidatePath(`/${slug}/p`, "layout");
  return { ok: true };
}

function failed(t: Translate, error: DataError): State {
  return { error: errorMessage(t, error) };
}

const uuid = z.uuid();
const reason = z.string().trim().min(1).max(500);
const text = (form: FormData, key: string) => {
  const v = form.get(key);
  return typeof v === "string" ? v : "";
};

function invalid(t: Translate, fields: Record<string, string>): State {
  return {
    error: t("crew.errors.fixFields"),
    fieldErrors: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, t(v)])),
  };
}

// Shifts --------------------------------------------------------------------------------------------

function shiftTimes(form: FormData, t: Translate) {
  const zone = text(form, "timeZone");
  const startsAt = zonedToIso(text(form, "startsAt"), zone);
  const endsAt = zonedToIso(text(form, "endsAt"), zone);
  const errors: Record<string, string> = {};
  if (!startsAt) errors["startsAt"] = "crew.errors.dateTime";
  if (!endsAt) errors["endsAt"] = "crew.errors.dateTime";
  if (startsAt && endsAt && endsAt <= startsAt) errors["endsAt"] = "crew.errors.endAfterStart";
  return Object.keys(errors).length > 0
    ? { ok: false as const, state: invalid(t, errors) }
    : { ok: true as const, startsAt: startsAt as string, endsAt: endsAt as string, zone };
}

export async function createShiftAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const project = uuid.safeParse(form.get("projectId"));
  if (!project.success) return invalid(t, { projectId: "crew.errors.project" });
  const times = shiftTimes(form, t);
  if (!times.ok) return times.state;
  const member = text(form, "membershipId");
  const role = text(form, "roleCode");
  const result = await createShift(db, {
    orgId: ctx.org.id,
    projectId: project.data,
    roleCode: role === "" ? null : role,
    startsAt: times.startsAt,
    endsAt: times.endsAt,
    timeZone: times.zone,
    membershipId: member === "" ? null : member,
  });
  return done(ctx.org.slug, result, t);
}

export async function updateShiftAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return failed(t, { kind: "not-found" });
  const times = shiftTimes(form, t);
  if (!times.ok) return times.state;
  const member = text(form, "membershipId");
  const role = text(form, "roleCode");
  const result = await updateShift(db, id.data, {
    roleCode: role === "" ? null : role,
    startsAt: times.startsAt,
    endsAt: times.endsAt,
    timeZone: times.zone,
    membershipId: member === "" ? null : member,
  });
  return done(ctx.org.slug, result, t);
}

const SHIFT_STATE = z.enum(["Draft", "Published", "Accepted", "Canceled"]);

export async function transitionShiftAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ id: uuid, expected: SHIFT_STATE, next: SHIFT_STATE, reason })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { reason: "crew.errors.reason" });
  const p = parsed.data;
  return done(
    ctx.org.slug,
    await transitionShift(db, p.id, p.expected as ShiftState, p.next as ShiftState, p.reason),
    t,
  );
}

export async function publishShiftsAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const ids = text(form, "ids")
    .split(",")
    .filter((s) => uuid.safeParse(s).success);
  const r = reason.safeParse(form.get("reason"));
  if (!r.success) return invalid(t, { reason: "crew.errors.reason" });
  if (ids.length === 0) return { error: t("crew.errors.nothingToPublish") };
  return done(ctx.org.slug, await publishShifts(db, ids, r.data), t);
}

export async function acceptShiftAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  const r = reason.safeParse(form.get("reason"));
  if (!id.success || !r.success) return invalid(t, { reason: "crew.errors.reason" });
  return done(ctx.org.slug, await acceptShift(db, id.data, r.data), t);
}

export async function claimShiftAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  const r = reason.safeParse(form.get("reason"));
  if (!id.success || !r.success) return invalid(t, { reason: "crew.errors.reason" });
  return done(ctx.org.slug, await claimOpenShift(db, id.data, r.data), t);
}

/** A supervisor approves or rejects a waiting open shift claim (scheduling.open_shift_claiming, 1322). */
export async function decideClaimAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ id: uuid, decision: DECISION, reason: z.string().trim().max(500).optional() })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { reason: "crew.errors.reason" });
  const approved = parsed.data.decision === "Approved";
  if (!approved && !parsed.data.reason) return invalid(t, { reason: "crew.errors.reason" });
  return done(
    ctx.org.slug,
    await decideShiftClaim(db, parsed.data.id, approved, parsed.data.reason || null),
    t,
  );
}

/** Under the seniority rule, gives the open shift to the most senior claimant. */
export async function awardShiftAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  const r = reason.safeParse(form.get("reason"));
  if (!id.success || !r.success) return invalid(t, { reason: "crew.errors.reason" });
  return done(ctx.org.slug, await awardOpenShift(db, id.data, r.data), t);
}

/** The claimant withdraws their waiting claim. */
export async function withdrawClaimAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return failed(t, { kind: "not-found" });
  return done(ctx.org.slug, await withdrawShiftClaim(db, id.data), t);
}

export async function trashShiftAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return failed(t, { kind: "not-found" });
  const result = await trashShift(db, id.data);
  const state = done(ctx.org.slug, result, t);
  return state.ok
    ? { ...state, redirect: text(form, "back") || `/${ctx.org.slug}/crew/shifts` }
    : state;
}

// Swaps ---------------------------------------------------------------------------------------------

export async function requestSwapAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ shiftId: uuid, projectId: uuid, proposedMembershipId: uuid })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { proposedMembershipId: "crew.errors.person" });
  return done(
    ctx.org.slug,
    await requestSwap(db, {
      orgId: ctx.org.id,
      projectId: parsed.data.projectId,
      shiftId: parsed.data.shiftId,
      requestedByMembershipId: ctx.org.membershipId,
      proposedMembershipId: parsed.data.proposedMembershipId,
    }),
    t,
  );
}

const DECISION = z.enum(["Approved", "Rejected"]);

export async function decideSwapAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ id: uuid, decision: DECISION, reason })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { reason: "crew.errors.reason" });
  return done(
    ctx.org.slug,
    await decideSwap(db, parsed.data.id, parsed.data.decision, parsed.data.reason),
    t,
  );
}

/** The person offered a shift accepts the swap, where swaps need no supervisor (1322). */
export async function acceptSwapAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z.object({ id: uuid, reason }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { reason: "crew.errors.reason" });
  return done(ctx.org.slug, await acceptSwap(db, parsed.data.id, parsed.data.reason), t);
}

export async function cancelSwapAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z.object({ id: uuid, reason }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { reason: "crew.errors.reason" });
  return done(ctx.org.slug, await cancelSwap(db, parsed.data.id, parsed.data.reason), t);
}

// Time entries ---------------------------------------------------------------------------------------

function entryTimes(form: FormData, t: Translate) {
  const zone = text(form, "timeZone");
  const clockInAt = zonedToIso(text(form, "clockIn"), zone);
  const outRaw = text(form, "clockOut");
  const clockOutAt = outRaw === "" ? null : zonedToIso(outRaw, zone);
  const breakMinutes = Number(text(form, "breakMinutes") || "0");
  const errors: Record<string, string> = {};
  if (!clockInAt) errors["clockIn"] = "crew.errors.dateTime";
  if (outRaw !== "" && !clockOutAt) errors["clockOut"] = "crew.errors.dateTime";
  if (clockInAt && clockOutAt && clockOutAt <= clockInAt)
    errors["clockOut"] = "crew.errors.endAfterStart";
  if (!Number.isInteger(breakMinutes) || breakMinutes < 0 || breakMinutes > 1440) {
    errors["breakMinutes"] = "crew.errors.breakMinutes";
  }
  return Object.keys(errors).length > 0
    ? { ok: false as const, state: invalid(t, errors) }
    : { ok: true as const, clockIn: clockInAt as string, clockOut: clockOutAt, breakMinutes };
}

export async function createTimeEntryAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const ids = z
    .object({ projectId: uuid, membershipId: uuid })
    .safeParse({ projectId: form.get("projectId"), membershipId: form.get("membershipId") });
  if (!ids.success)
    return invalid(t, { projectId: "crew.errors.project", membershipId: "crew.errors.person" });
  const times = entryTimes(form, t);
  if (!times.ok) return times.state;
  const shift = text(form, "shiftId");
  return done(
    ctx.org.slug,
    await createTimeEntry(db, {
      orgId: ctx.org.id,
      projectId: ids.data.projectId,
      membershipId: ids.data.membershipId,
      shiftId: shift === "" ? null : shift,
      clockIn: times.clockIn,
      clockOut: times.clockOut,
      breakMinutes: times.breakMinutes,
    }),
    t,
  );
}

export async function updateTimeEntryAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return failed(t, { kind: "not-found" });
  const times = entryTimes(form, t);
  if (!times.ok) return times.state;
  return done(
    ctx.org.slug,
    await updateTimeEntry(db, id.data, {
      clockIn: times.clockIn,
      clockOut: times.clockOut,
      breakMinutes: times.breakMinutes,
    }),
    t,
  );
}

export async function voidTimeEntryAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return failed(t, { kind: "not-found" });
  return done(ctx.org.slug, await voidTimeEntry(db, id.data), t);
}

/** Clocks the viewer in from Atlas on a shift of theirs (Compass is the field path). */
export async function clockInAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z.object({ shiftId: uuid, projectId: uuid }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return failed(t, { kind: "not-found" });
  return done(
    ctx.org.slug,
    await clockIn(db, {
      orgId: ctx.org.id,
      projectId: parsed.data.projectId,
      membershipId: ctx.org.membershipId,
      shiftId: parsed.data.shiftId,
      source: "Web",
    }),
    t,
  );
}

export async function clockOutAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  const breakMinutes = Number(text(form, "breakMinutes") || "0");
  if (!id.success) return failed(t, { kind: "not-found" });
  if (!Number.isInteger(breakMinutes) || breakMinutes < 0) {
    return invalid(t, { breakMinutes: "crew.errors.breakMinutes" });
  }
  return done(ctx.org.slug, await clockOut(db, id.data, breakMinutes), t);
}

export async function requestCorrectionAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return failed(t, { kind: "not-found" });
  const times = entryTimes(form, t);
  if (!times.ok) return times.state;
  const why = reason.safeParse(form.get("reason"));
  if (!why.success) return invalid(t, { reason: "crew.errors.reason" });
  return done(
    ctx.org.slug,
    await requestCorrection(db, {
      orgId: ctx.org.id,
      timeEntryId: id.data,
      clockIn: times.clockIn,
      clockOut: times.clockOut,
      breakMinutes: times.breakMinutes,
      reason: why.data,
    }),
    t,
  );
}

export async function decideCorrectionAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ id: uuid, decision: DECISION, reason })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { reason: "crew.errors.reason" });
  return done(
    ctx.org.slug,
    await decideCorrection(db, parsed.data.id, parsed.data.decision, parsed.data.reason),
    t,
  );
}

// Timesheets ------------------------------------------------------------------------------------------

const isoDate = z.iso.date();

export async function createTimesheetAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ projectId: uuid, membershipId: uuid, periodStart: isoDate, periodEnd: isoDate })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success)
    return invalid(t, { periodStart: "crew.errors.date", periodEnd: "crew.errors.date" });
  if (parsed.data.periodEnd < parsed.data.periodStart) {
    return invalid(t, { periodEnd: "crew.errors.endAfterStart" });
  }
  return done(ctx.org.slug, await createTimesheet(db, { orgId: ctx.org.id, ...parsed.data }), t);
}

export async function submitTimesheetAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z.object({ id: uuid, reason }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { reason: "crew.errors.reason" });
  return done(ctx.org.slug, await submitTimesheet(db, parsed.data.id, parsed.data.reason), t);
}

export async function decideTimesheetAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ id: uuid, decision: DECISION, reason })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { reason: "crew.errors.reason" });
  return done(
    ctx.org.slug,
    await decideTimesheet(db, parsed.data.id, parsed.data.decision, parsed.data.reason),
    t,
  );
}

// Rate cards and pay rates --------------------------------------------------------------------------------

async function exponentOf(form: FormData, currency: string): Promise<number> {
  const { db } = await context(form);
  const { data, error } = await db
    .from("currencies")
    .select("minor_unit_exponent")
    .eq("currency_code", currency)
    .maybeSingle();
  if (error) throw new Error(`Cannot read currency ${currency}: ${error.message}`);
  return data?.minor_unit_exponent ?? 2;
}

export async function createRateCardAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(200),
      currencyCode: z.string().regex(/^[A-Z]{3}$/),
      effectiveFrom: isoDate,
      effectiveTo: z.union([isoDate, z.literal("")]),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success)
    return invalid(t, { name: "crew.errors.name", effectiveFrom: "crew.errors.date" });
  const p = parsed.data;
  if (p.effectiveTo !== "" && p.effectiveTo < p.effectiveFrom) {
    return invalid(t, { effectiveTo: "crew.errors.endAfterStart" });
  }
  const result = await createRateCard(db, ctx.org.id, {
    name: p.name,
    currencyCode: p.currencyCode,
    effectiveFrom: p.effectiveFrom,
    effectiveTo: p.effectiveTo === "" ? null : p.effectiveTo,
  });
  if (!result.ok) return failed(t, result.error);
  revalidatePath(`/${ctx.org.slug}/crew`, "layout");
  return { ok: true, redirect: `/${ctx.org.slug}/crew/rate-cards?card=${result.data.id}` };
}

export async function updateRateCardAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({
      id: uuid,
      name: z.string().trim().min(1).max(200),
      effectiveFrom: isoDate,
      effectiveTo: z.union([isoDate, z.literal("")]),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success)
    return invalid(t, { name: "crew.errors.name", effectiveFrom: "crew.errors.date" });
  const p = parsed.data;
  return done(
    ctx.org.slug,
    await updateRateCard(db, p.id, {
      name: p.name,
      effectiveFrom: p.effectiveFrom,
      effectiveTo: p.effectiveTo === "" ? null : p.effectiveTo,
    }),
    t,
  );
}

export async function addRateLineAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({
      rateCardId: uuid,
      currencyCode: z.string().regex(/^[A-Z]{3}$/),
      roleCode: z.string().regex(/^\d{4}\.\d{2}\.\d{2}$/),
      worker: z.string().min(1),
      overtimeRuleId: z.string().min(1),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { roleCode: "crew.errors.role" });
  const [payBasis, classification] = text(form, "payBasis").split("|");
  const [arrangement, classification2] = text(form, "arrangement").split("|");
  if (
    !payBasis ||
    !arrangement ||
    classification !== parsed.data.worker ||
    classification2 !== parsed.data.worker
  ) {
    return invalid(t, {
      payBasis: "crew.errors.combination",
      arrangement: "crew.errors.combination",
    });
  }
  const rate = toMinor(text(form, "rate"), await exponentOf(form, parsed.data.currencyCode));
  if (rate === undefined) return invalid(t, { rate: "crew.errors.money" });
  const canon = text(form, "canonRateCardId");
  return done(
    ctx.org.slug,
    await addRateCardLine(db, ctx.org.id, parsed.data.rateCardId, {
      roleCode: parsed.data.roleCode,
      workerClassification: parsed.data.worker,
      payBasis,
      arrangement,
      overtimeRuleId: parsed.data.overtimeRuleId,
      canonRateCardId: canon === "" ? null : canon,
      rateMinor: rate,
    }),
    t,
  );
}

export async function updateRateLineAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  const currency = text(form, "currencyCode");
  if (!id.success) return failed(t, { kind: "not-found" });
  const rate = toMinor(text(form, "rate"), await exponentOf(form, currency));
  if (rate === undefined) return invalid(t, { rate: "crew.errors.money" });
  const rule = text(form, "overtimeRuleId");
  return done(
    ctx.org.slug,
    await updateRateCardLine(db, id.data, {
      rateMinor: rate,
      ...(rule ? { overtimeRuleId: rule } : {}),
    }),
    t,
  );
}

/** Saves rates edited in the rate card grid, all or nothing; blank cells unprice their line. */
export async function saveRatesAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const changes = z
    .array(z.object({ id: uuid, rate: z.number().nonnegative().nullable() }))
    .max(500)
    .safeParse(JSON.parse(text(form, "changes") || "[]"));
  if (!changes.success) return { error: t("crew.errors.money") };
  const exponent = await exponentOf(form, text(form, "currencyCode"));
  for (const c of changes.data) {
    const minor = c.rate === null ? null : Math.round(c.rate * 10 ** exponent);
    const result = await updateRateCardLine(db, c.id, { rateMinor: minor });
    if (!result.ok) return failed(t, result.error);
  }
  revalidatePath(`/${ctx.org.slug}/crew`, "layout");
  return { ok: true };
}

export async function trashRateCardAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return failed(t, { kind: "not-found" });
  const result = await trashRateCard(db, id.data);
  if (!result.ok) return failed(t, result.error);
  revalidatePath(`/${ctx.org.slug}/crew`, "layout");
  return { ok: true, redirect: `/${ctx.org.slug}/crew/rate-cards` };
}

export async function removeRateLineAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return failed(t, { kind: "not-found" });
  return done(ctx.org.slug, await removeRateCardLine(db, id.data), t);
}

export async function recordPayRateAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({
      membershipId: uuid,
      roleCode: z.string().regex(/^\d{4}\.\d{2}\.\d{2}$/),
      currencyCode: z.string().regex(/^[A-Z]{3}$/),
      effectiveFrom: isoDate,
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success)
    return invalid(t, { membershipId: "crew.errors.person", roleCode: "crew.errors.role" });
  const rate = toMinor(text(form, "rate"), await exponentOf(form, parsed.data.currencyCode));
  if (rate === undefined || rate === null) return invalid(t, { rate: "crew.errors.moneyRequired" });
  return done(
    ctx.org.slug,
    await recordPayRate(db, { orgId: ctx.org.id, ...parsed.data, rateMinor: rate }),
    t,
  );
}

// Pay periods and payroll runs ------------------------------------------------------------------------------

export async function createPayPeriodAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ startsOn: isoDate, endsOn: isoDate })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success)
    return invalid(t, { startsOn: "crew.errors.date", endsOn: "crew.errors.date" });
  if (parsed.data.endsOn < parsed.data.startsOn)
    return invalid(t, { endsOn: "crew.errors.endAfterStart" });
  return done(ctx.org.slug, await createPayPeriod(db, ctx.org.id, parsed.data), t);
}

export async function updatePayPeriodAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ id: uuid, startsOn: isoDate, endsOn: isoDate })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success)
    return invalid(t, { startsOn: "crew.errors.date", endsOn: "crew.errors.date" });
  if (parsed.data.endsOn < parsed.data.startsOn)
    return invalid(t, { endsOn: "crew.errors.endAfterStart" });
  return done(ctx.org.slug, await updatePayPeriod(db, parsed.data.id, parsed.data), t);
}

const PERIOD_STATE = z.enum(["Open", "Closed", "Posted"]);

export async function transitionPayPeriodAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ id: uuid, expected: PERIOD_STATE, next: PERIOD_STATE, reason })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { reason: "crew.errors.reason" });
  const p = parsed.data;
  return done(
    ctx.org.slug,
    await transitionPayPeriod(
      db,
      p.id,
      p.expected as PayPeriodState,
      p.next as PayPeriodState,
      p.reason,
    ),
    t,
  );
}

export async function createPayrollRunAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ payPeriodId: uuid, currencyCode: z.string().regex(/^[A-Z]{3}$/) })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { currencyCode: "crew.errors.currency" });
  return done(ctx.org.slug, await createPayrollRun(db, { orgId: ctx.org.id, ...parsed.data }), t);
}

export async function calculateRunAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z.object({ id: uuid, reason }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { reason: "crew.errors.reason" });
  return done(ctx.org.slug, await calculatePayrollRun(db, parsed.data.id, parsed.data.reason), t);
}

export async function approveRunAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z.object({ id: uuid, reason }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { reason: "crew.errors.reason" });
  const result = await approvePayrollRun(db, parsed.data.id, parsed.data.reason);
  if (!result.ok) return failed(t, result.error);
  revalidatePath(`/${ctx.org.slug}/crew`, "layout");
  return result.data.complete
    ? { ok: true }
    : { ok: true, error: t("crew.payroll.secondApprover") };
}

const RUN_STATE = z.enum(["Draft", "Calculated", "Approved", "Exported", "Accepted", "Canceled"]);

export async function transitionRunAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ id: uuid, expected: RUN_STATE, next: RUN_STATE, reason })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { reason: "crew.errors.reason" });
  const p = parsed.data;
  return done(
    ctx.org.slug,
    await transitionPayrollRun(
      db,
      p.id,
      p.expected as PayrollRunState,
      p.next as PayrollRunState,
      p.reason,
    ),
    t,
  );
}

/** Produces the export file of an Approved run. Plan-gated in the app first, then in SQL. */
export async function produceExportAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return failed(t, { kind: "not-found" });
  if (!(await planHasFeature(ctx, "payroll_export"))) {
    return { error: t("crew.refusals.plan_feature_required") };
  }
  const result = await producePayrollExport(db, id.data, "CSV");
  if (!result.ok) return failed(t, result.error);
  revalidatePath(`/${ctx.org.slug}/crew`, "layout");
  return { ok: true, file: { name: `payroll-${id.data}.csv`, content: result.data.content } };
}

export async function downloadExportAction(_: State, form: FormData): Promise<State> {
  const { db, t } = await context(form);
  const id = uuid.safeParse(form.get("id"));
  if (!id.success) return failed(t, { kind: "not-found" });
  const result = await payrollExportFile(db, id.data);
  if (!result.ok) return failed(t, result.error);
  return { file: { name: `payroll-export-${id.data}.csv`, content: result.data.content } };
}

// Time off ----------------------------------------------------------------------------------------------

export async function requestTimeOffAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({
      policyId: uuid,
      membershipId: uuid,
      startsOn: isoDate,
      endsOn: isoDate,
      hours: z.coerce.number().positive().max(10000),
    })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success)
    return invalid(t, { startsOn: "crew.errors.date", hours: "crew.errors.hours" });
  if (parsed.data.endsOn < parsed.data.startsOn)
    return invalid(t, { endsOn: "crew.errors.endAfterStart" });
  return done(ctx.org.slug, await requestTimeOff(db, { orgId: ctx.org.id, ...parsed.data }), t);
}

export async function decideTimeOffAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ id: uuid, decision: DECISION, reason })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { reason: "crew.errors.reason" });
  return done(
    ctx.org.slug,
    await decideTimeOff(db, parsed.data.id, parsed.data.decision, parsed.data.reason),
    t,
  );
}

const OFF_STATE = z.enum(["Proposed", "Approved", "Rejected", "Canceled"]);

export async function cancelTimeOffAction(_: State, form: FormData): Promise<State> {
  const { ctx, db, t } = await context(form);
  const parsed = z
    .object({ id: uuid, expected: OFF_STATE, reason })
    .safeParse(Object.fromEntries(form));
  if (!parsed.success) return invalid(t, { reason: "crew.errors.reason" });
  return done(
    ctx.org.slug,
    await cancelTimeOff(
      db,
      parsed.data.id,
      parsed.data.expected as TimeOffState,
      parsed.data.reason,
    ),
    t,
  );
}
