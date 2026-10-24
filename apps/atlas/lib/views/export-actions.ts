"use server";

import type { DataError } from "@xos/data";
import {
  collectionExportDownload,
  EXPORT_FORMATS,
  getCollectionExport,
  requestCollectionExport,
  type ExportFilter,
  type ExportFormat,
  type ExportStatus,
} from "@xos/data/collection-exports";
import { getObjectType } from "@xos/data/custom-objects";
import { getProjectByKey } from "@xos/data/projects";
import { findRoute, getNode } from "@xos/ia";
import { getTranslations } from "next-intl/server";
import { z } from "zod";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";
import type { Translate } from "@/lib/shell/translate";
import { exportSourceFor, planExport, type ExportPlan } from "./export-sources";
import { collectionKeyFor } from "./query";

/**
 * Server actions behind the export menu of every collection (A102, Section 4.6.4). The page's path
 * and query say what is on screen; the source registry turns that into the columns of one table or
 * view and their filters, and app.request_export applies Section 8.6 with the viewer's own client:
 * a Restricted column answers `stepUp` until the session passed a second factor. The worker renders
 * the file; the menu follows it and downloads it through a short-lived signed link.
 */

export type ExportError =
  "unavailable" | "denied" | "stepUp" | "medical" | "expired" | "invalid" | "unexpected";

export type ExportResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: ExportError };

const ID = z.string().uuid();
const REQUEST = z.object({
  pathname: z.string().min(2).max(500),
  search: z.string().max(4000),
  format: z.enum(EXPORT_FORMATS as [ExportFormat, ...ExportFormat[]]),
});

function errorOf(error: DataError): ExportError {
  if (error.kind === "refusal") {
    if (error.rule === "step_up_required") return "stepUp";
    if (error.rule === "export_medical_excluded") return "medical";
    if (error.rule === "export_not_ready") return "expired";
    if (["export_restricted", "export_confidential", "step_up_session_only"].includes(error.rule)) {
      return "denied";
    }
    return "invalid";
  }
  if (error.kind === "not-found") return "denied";
  if (error.kind === "invalid" || error.kind === "conflict") return "invalid";
  return "unexpected";
}

/** A column name as words, for a column the catalog has no header for. */
function words(column: string): string {
  const text = column.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The collection's name for the export list: the page, after its module or project. */
function sourceLabel(t: Translate, pathname: string): string {
  const match = findRoute(sitemap, pathname);
  if (!match) return words(pathname.split("/").filter(Boolean).slice(1).join(" "));
  const entry = getNode(sitemap, match.id);
  const page = t(entry.node.label);
  const project = match.params["projectKey"];
  const parent = entry.parent?.node;
  const scope = project ?? (parent && parent.kind === "item" ? t(parent.label) : null);
  return scope && scope !== page ? t("views.export.source", { scope, page }) : page;
}

/** The plan's filters with project keys and the object key resolved to ids the viewer can read. */
async function resolveFilters(
  ctx: OrgContext,
  plan: ExportPlan,
): Promise<readonly ExportFilter[] | null> {
  const db = ctx.viewer.db;
  const projectId = async (key: string): Promise<string> => {
    const project = await getProjectByKey(db, ctx.org.id, key);
    // A key the viewer cannot open matches no row, as the page shows none.
    return project.ok ? project.data.id : key;
  };
  const filters: ExportFilter[] = [];
  if (plan.projectKey) {
    filters.push({ operator: "eq", column: "project_id", value: await projectId(plan.projectKey) });
  }
  if (plan.objectKey) {
    const type = await getObjectType(db, ctx.org.id, plan.objectKey);
    if (!type.ok) return null;
    filters.push({ operator: "eq", column: "custom_object_type_id", value: type.data.id });
  }
  for (const filter of plan.filters) {
    if (filter.operator === "search") filters.push(filter);
    else if (filter.resolve === "project") {
      filters.push({ operator: "eq", column: filter.column, value: await projectId(filter.value) });
    } else filters.push({ operator: filter.operator, column: filter.column, value: filter.value });
  }
  return filters;
}

/** Asks for an export of the collection on screen; answers the export's id. */
export async function requestCollectionExportAction(
  orgSlug: string,
  input: { readonly pathname: string; readonly search: string; readonly format: ExportFormat },
): Promise<ExportResult<{ readonly id: string }>> {
  const parsed = REQUEST.safeParse(input);
  if (!parsed.success || !parsed.data.pathname.startsWith(`/${orgSlug}/`)) {
    return { ok: false, error: "invalid" };
  }
  const ctx = await getOrgContext(orgSlug);
  if (!ctx) return { ok: false, error: "denied" };
  const search = new URLSearchParams(parsed.data.search);
  const source = exportSourceFor(collectionKeyFor(parsed.data.pathname), search);
  if (!source) return { ok: false, error: "unavailable" };
  const plan = planExport(source, parsed.data.pathname, search);
  const filters = plan ? await resolveFilters(ctx, plan) : null;
  if (!filters) return { ok: false, error: "unavailable" };
  // Keys computed at runtime; the catalog tests hold every column of every source present.
  const t = (await getTranslations()) as unknown as Translate & { has: (key: string) => boolean };
  const header = (column: string) => {
    const key = `views.export.columns.${column}`;
    return t.has(key) ? t(key) : words(column);
  };
  const requested = await requestCollectionExport(ctx.viewer.db, {
    orgId: ctx.org.id,
    format: parsed.data.format,
    label: sourceLabel(t, parsed.data.pathname),
    relation: source.relation,
    columns: source.columns,
    headers: source.columns.map(header),
    filters,
  });
  if (!requested.ok) return { ok: false, error: errorOf(requested.error) };
  return { ok: true, data: { id: requested.data } };
}

/** Where the viewer's export stands: Queued, Rendering, Ready (with its rows), Failed (with why), Expired. */
export async function collectionExportStatusAction(
  orgSlug: string,
  id: string,
): Promise<
  ExportResult<{
    readonly status: ExportStatus;
    readonly rowCount: number | null;
    readonly error: string | null;
  }>
> {
  if (!ID.safeParse(id).success) return { ok: false, error: "invalid" };
  const ctx = await getOrgContext(orgSlug);
  if (!ctx) return { ok: false, error: "denied" };
  const found = await getCollectionExport(ctx.viewer.db, id);
  if (!found.ok) return { ok: false, error: errorOf(found.error) };
  return {
    ok: true,
    data: { status: found.data.status, rowCount: found.data.rowCount, error: found.data.error },
  };
}

/** A signed link that downloads the viewer's Ready export once; each download is logged. */
export async function collectionExportDownloadAction(
  orgSlug: string,
  id: string,
): Promise<ExportResult<{ readonly url: string; readonly fileName: string }>> {
  if (!ID.safeParse(id).success) return { ok: false, error: "invalid" };
  const ctx = await getOrgContext(orgSlug);
  if (!ctx) return { ok: false, error: "denied" };
  const link = await collectionExportDownload(ctx.viewer.db, id);
  if (!link.ok) return { ok: false, error: errorOf(link.error) };
  return { ok: true, data: link.data };
}
