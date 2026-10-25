"use server";

import type { DataError } from "@xos/data";
import { revokeSharedReport, runReport, shareReport } from "@xos/data/reports";
import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { z } from "zod";
import type { ActionError, ActionState } from "@/app/[org]/finance/actions";
import { getOrgContext } from "@/lib/shell/context";
import { observability } from "@/lib/observability";

/**
 * Reports actions (A15): run a saved report through A18's app.run_report, share a finished run with
 * one engagement, and revoke a share (0992). The database decides every write; refusals return their
 * rule for the catalog copy under `finance.refusals`.
 */

function toError(error: DataError): ActionError {
  if (error.kind === "refusal") return error;
  if (error.kind === "unexpected")
    observability.logger.error("reports action failed", { error: error });
  return { kind: error.kind === "unexpected" ? "unexpected" : error.kind };
}

async function contextFor(form: FormData) {
  const slug = form.get("org");
  const ctx = typeof slug === "string" ? await getOrgContext(slug) : null;
  if (!ctx) notFound();
  return ctx;
}

export async function runReportAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({ reportDefinitionId: z.uuid(), format: z.enum(["CSV", "XLSX", "PDF"]) })
    .safeParse({ reportDefinitionId: form.get("reportDefinitionId"), format: form.get("format") });
  if (!parsed.success) return { error: { kind: "input" }, fieldErrors: { format: "target" } };
  const result = await runReport(ctx.viewer.db, parsed.data);
  if (!result.ok) return { error: toError(result.error), at: Date.now() };
  revalidatePath(`/${ctx.org.slug}/reports`, "layout");
  return { ok: true, id: result.data.id, at: Date.now() };
}

export async function shareReportAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const parsed = z
    .object({
      reportRunId: z.uuid(),
      engagementId: z.uuid(),
      title: z.string().trim().min(1).max(200),
      expiresAt: z
        .string()
        .trim()
        .transform((s) => (s === "" ? null : s))
        .pipe(z.iso.date().nullable()),
    })
    .safeParse({
      reportRunId: form.get("reportRunId"),
      engagementId: form.get("engagementId"),
      title: form.get("title"),
      expiresAt: form.get("expiresAt") ?? "",
    });
  if (!parsed.success) {
    const field = String(parsed.error.issues[0]?.path[0] ?? "title");
    return {
      error: { kind: "input" },
      fieldErrors: {
        [field]:
          field === "expiresAt" ? "date" : field === "engagementId" ? "engagementId" : "title",
      },
    };
  }
  const result = await shareReport(ctx.viewer.db, {
    ...parsed.data,
    expiresAt: parsed.data.expiresAt ? `${parsed.data.expiresAt}T23:59:59Z` : null,
  });
  if (!result.ok) return { error: toError(result.error), at: Date.now() };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true, id: result.data.id, at: Date.now() };
}

export async function revokeShareAction(_: ActionState, form: FormData): Promise<ActionState> {
  const ctx = await contextFor(form);
  const id = z.uuid().safeParse(form.get("id"));
  if (!id.success) return { error: { kind: "not-found" } };
  const result = await revokeSharedReport(ctx.viewer.db, id.data);
  if (!result.ok) return { error: toError(result.error), at: Date.now() };
  revalidatePath(`/${ctx.org.slug}`, "layout");
  return { ok: true, at: Date.now() };
}
