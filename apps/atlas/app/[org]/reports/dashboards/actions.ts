"use server";

import type { DataError, Result } from "@xos/data";
import * as boards from "@xos/data/dashboards";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import type { ActionError, ActionState } from "@/app/[org]/finance/actions";
import { getOrgContext } from "@/lib/shell/context";

/**
 * Dashboards and scheduled report email (A43, finding A38-004; journey 29). Each action validates
 * its input and lets row level security and the database decide; field errors name keys under
 * `reporting.errors`.
 */

function toError(error: DataError): ActionError {
  if (error.kind === "refusal") return error;
  if (error.kind === "unexpected") console.error("dashboards action failed", error);
  return { kind: error.kind === "unexpected" ? "unexpected" : error.kind };
}

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

function finish(slug: string, result: Result<unknown>, extra: ActionState = {}): ActionState {
  if (!result.ok) return { error: toError(result.error), at: Date.now() };
  revalidatePath(`/${slug}/reports`, "layout");
  return { ok: true, at: Date.now(), ...extra };
}

const field = (name: string): ActionState => ({
  error: { kind: "input" },
  fieldErrors: { [name]: name },
  at: Date.now(),
});

const id = z.uuid();

export async function createDashboardAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const name = z.string().trim().min(1).max(100).safeParse(form.get("name"));
  if (!name.success) return field("name");
  const result = await boards.createDashboard(ctx.viewer.db, {
    orgId: ctx.org.id,
    membershipId: ctx.org.membershipId,
    name: name.data,
  });
  return finish(ctx.org.slug, result, result.ok ? { id: result.data.id } : {});
}

export async function deleteDashboardAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const target = id.safeParse(form.get("id"));
  if (!target.success) return { error: { kind: "not-found" } };
  return finish(ctx.org.slug, await boards.deleteDashboard(ctx.viewer.db, target.data));
}

export async function addTileAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const dashboard = id.safeParse(form.get("dashboardId"));
  if (!dashboard.success) return field("dashboardId");
  const report = id.safeParse(form.get("reportDefinitionId"));
  if (!report.success) return { error: { kind: "not-found" } };
  const width = z.coerce.number().int().min(1).max(12).catch(6).parse(form.get("columnSpan"));
  const result = await boards.addTile(ctx.viewer.db, {
    orgId: ctx.org.id,
    dashboardId: dashboard.data,
    reportDefinitionId: report.data,
    columnSpan: width,
  });
  return finish(ctx.org.slug, result, result.ok ? { id: result.data.id } : {});
}

export async function removeTileAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const target = id.safeParse(form.get("id"));
  if (!target.success) return { error: { kind: "not-found" } };
  return finish(ctx.org.slug, await boards.removeTile(ctx.viewer.db, target.data));
}

export async function createScheduleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const report = id.safeParse(form.get("reportDefinitionId"));
  if (!report.success) return { error: { kind: "not-found" } };
  const cadence = z.enum(boards.CADENCES).safeParse(form.get("cadence"));
  if (!cadence.success) return field("cadence");
  const hour = z.coerce.number().int().min(0).max(23).safeParse(form.get("localHour"));
  if (!hour.success) return field("localHour");
  const weekday = z.coerce.number().int().min(1).max(7).safeParse(form.get("weekday"));
  if (cadence.data === "Weekly" && !weekday.success) return field("weekday");
  const monthDay = z.coerce.number().int().min(1).max(28).safeParse(form.get("monthDay"));
  if (cadence.data === "Monthly" && !monthDay.success) return field("monthDay");
  const zone = z.string().trim().min(1).max(64).safeParse(form.get("timeZone"));
  if (!zone.success) return field("timeZone");
  const format = z.enum(boards.EXPORT_FORMATS).safeParse(form.get("format"));
  if (!format.success) return field("format");
  const recipients = form
    .getAll("recipients")
    .map(String)
    .filter((r) => id.safeParse(r).success);
  if (recipients.length === 0) return field("recipients");
  const result = await boards.createSchedule(ctx.viewer.db, {
    orgId: ctx.org.id,
    reportDefinitionId: report.data,
    cadence: cadence.data,
    localHour: hour.data,
    weekday: weekday.success ? weekday.data : null,
    monthDay: monthDay.success ? monthDay.data : null,
    timeZone: zone.data,
    format: format.data,
    recipientMembershipIds: recipients,
  });
  return finish(ctx.org.slug, result, result.ok ? { id: result.data.id } : {});
}

export async function pauseScheduleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const target = id.safeParse(form.get("id"));
  if (!target.success) return { error: { kind: "not-found" } };
  const paused = form.get("paused") === "1";
  return finish(ctx.org.slug, await boards.setSchedulePaused(ctx.viewer.db, target.data, paused));
}

export async function deleteScheduleAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const target = id.safeParse(form.get("id"));
  if (!target.success) return { error: { kind: "not-found" } };
  return finish(ctx.org.slug, await boards.deleteSchedule(ctx.viewer.db, target.data));
}
