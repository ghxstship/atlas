"use server";

import type { DataError } from "@xos/data";
import { choosePlanLimitKeeps, OBJECT_LIMITS, type ObjectLimit } from "@xos/data/plan-limits";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { observability } from "@/lib/observability";
import { getOrgContext } from "@/lib/shell/context";

/**
 * The Owner's choice of what stays writable (A107, ADR 0081). The action resolves the viewer's org context again (404
 * when gone); app.choose_plan_limit_keeps decides who may choose and how many, and recomputes the read-only objects at
 * once. Refusals come back as `planLimits.errors.*` copy, and success says how many objects stay read-only.
 */

export interface PlanLimitChoiceState {
  readonly ok?: boolean;
  /** Copy to show: the outcome, or why it was refused. */
  readonly message?: string;
  readonly at?: number;
}

const KNOWN = new Set([
  "plan_limit_choice_too_many",
  "plan_limit_choice_unknown",
  "plan_limit_choice_limit",
]);

function errorKey(error: DataError): string {
  if (error.kind === "refusal") return KNOWN.has(error.rule) ? error.rule : "unexpected";
  if (error.kind === "not-found") return "denied";
  observability.logger.error("plan limit choice failed", { error: error });
  return "unexpected";
}

const schema = z.object({
  org: z.string().min(1),
  limit: z.enum(OBJECT_LIMITS),
  keep: z.array(z.uuid()).max(500),
});

export async function choosePlanLimitKeepsAction(
  _: PlanLimitChoiceState,
  form: FormData,
): Promise<PlanLimitChoiceState> {
  const t = (await getTranslations("planLimits")) as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;
  const parsed = schema.safeParse({
    org: form.get("org"),
    limit: form.get("limit"),
    keep: form.getAll("keep"),
  });
  if (!parsed.success) return { message: t("errors.unexpected"), at: Date.now() };
  const ctx = await getOrgContext(parsed.data.org);
  if (!ctx) notFound();
  const limit: ObjectLimit = parsed.data.limit;
  const result = await choosePlanLimitKeeps(ctx.viewer.db, ctx.org.id, limit, parsed.data.keep);
  if (!result.ok) return { message: t(`errors.${errorKey(result.error)}`), at: Date.now() };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true, message: t("panel.saved", { count: result.data }), at: Date.now() };
}
