import type { XosClient } from "../client.ts";
import { fail, ok, toDataError, type Result } from "../result.ts";
import { landed } from "./shared.ts";

/**
 * Break types (B9, migration 2985, ADR 0148 decision 4): the kinds of break an org's crew take, each paid or unpaid. A
 * Break Start punch names one; a paid break's minutes are worked time and never subtracted. Written on Settings > Time
 * and Attendance with org.time_attendance.write. No org has a type until it adds one.
 */

export interface BreakType {
  readonly id: string;
  readonly name: string;
  readonly paid: boolean;
  readonly plannedMinutes: number | null;
  readonly isDefault: boolean;
}

export interface BreakTypeInput {
  readonly name: string;
  readonly paid: boolean;
  /** 1 to 240; null when it varies. */
  readonly plannedMinutes: number | null;
}

/** The org's live break types, by name. */
export async function listBreakTypes(
  db: XosClient,
  orgId: string,
): Promise<Result<BreakType[]>> {
  const { data, error } = await db
    .from("break_types")
    .select("id, name, paid, planned_minutes, is_default")
    .eq("org_id", orgId)
    .is("deleted_at", null)
    .order("name");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.id,
      name: r.name,
      paid: r.paid,
      plannedMinutes: r.planned_minutes,
      isDefault: r.is_default,
    })),
  );
}

/** Creates a break type, or updates one when `id` is given. */
export async function saveBreakType(
  db: XosClient,
  orgId: string,
  input: BreakTypeInput & { readonly id?: string },
): Promise<Result<{ id: string }>> {
  const row = {
    name: input.name.trim(),
    paid: input.paid,
    planned_minutes: input.plannedMinutes,
  };
  if (input.id) {
    const { data, error } = await db
      .from("break_types")
      .update(row)
      .eq("id", input.id)
      .is("deleted_at", null)
      .select("id");
    if (error) return fail(toDataError(error));
    const updated = landed(data);
    return updated.ok ? ok({ id: input.id }) : updated;
  }
  const { data, error } = await db
    .from("break_types")
    .insert({ org_id: orgId, ...row })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Retires a break type (Trash); retiring the default clears it. */
export async function retireBreakType(
  db: XosClient,
  id: string,
  at: Date = new Date(),
): Promise<Result<null>> {
  const { data, error } = await db
    .from("break_types")
    .update({ deleted_at: at.toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return landed(data);
}

/** Makes a live break type the org's default in one step (app.set_default_break_type). */
export async function setDefaultBreakType(db: XosClient, id: string): Promise<Result<null>> {
  const { error } = await db.rpc("set_default_break_type", { p_id: id });
  if (error) return fail(toDataError(error));
  return ok(null);
}
