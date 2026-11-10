"use server";

import { retireBreakType, saveBreakType, setDefaultBreakType } from "@xos/data/crew";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { contextFor } from "@/lib/platform/action-context";
import { fromDataError } from "@/lib/platform/data-error";
import { done, field, inputError, type PlatformActionState } from "@/lib/platform/state";

/**
 * The server action of B9's Break types panel on Settings, Time and Attendance (RRR-233, ADR 0148 decision 4). It writes
 * with the viewer's client, so row level security (org.time_attendance.write) decides; `intent` picks create, update,
 * retire or default. A taken name comes back as the rule naming it, so the form says what is in use.
 */

const uuid = z.uuid();

function refresh(slug: string): void {
  revalidatePath(`/${slug}/settings/time-and-attendance`);
}

export async function breakTypeAction(
  _: PlatformActionState,
  form: FormData,
): Promise<PlatformActionState> {
  const ctx = await contextFor(form);
  const db = ctx.viewer.db;
  const intent = field(form, "intent");
  const id = field(form, "id");
  if (intent !== "create" && !uuid.safeParse(id).success) return inputError();
  if (intent === "retire" || intent === "default") {
    const result =
      intent === "retire" ? await retireBreakType(db, id) : await setDefaultBreakType(db, id);
    if (!result.ok) return fromDataError(result.error);
    refresh(ctx.org.slug);
    return done(id);
  }
  const name = field(form, "name");
  const raw = field(form, "plannedMinutes");
  const planned = raw === "" ? null : Number(raw);
  if (
    name.length === 0 ||
    name.length > 80 ||
    (planned !== null && (!Number.isInteger(planned) || planned < 1 || planned > 240)) ||
    (intent !== "create" && intent !== "update")
  ) {
    return inputError();
  }
  const result = await saveBreakType(db, ctx.org.id, {
    ...(intent === "update" ? { id } : {}),
    name,
    paid: field(form, "paid") === "on",
    plannedMinutes: planned,
  });
  if (!result.ok) {
    return result.error.kind === "conflict"
      ? { rule: "break_type_taken", at: Date.now() }
      : fromDataError(result.error);
  }
  refresh(ctx.org.slug);
  return done(result.data.id);
}
