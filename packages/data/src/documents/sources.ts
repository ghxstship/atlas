import type { XosClient } from "../client.ts";
import { getIssuedCredential } from "../credentials.ts";
import {
  listChangeOrderLines,
  listChangeOrders,
  listInvoiceLines,
  listInvoices,
} from "../finance.ts";
import { getBeo } from "../hospitality.ts";
import { getIncident, listIncidentHistory, listIncidentSeverities } from "../incidents.ts";
import { getAgreement } from "../people.ts";
import { getPurchaseOrder, getPurchaseOrderTotals, listPoLines } from "../procurement.ts";
import { finalCostReport } from "../reports.ts";
import { fail, ok, toDataError, type Result } from "../result.ts";
import {
  listInspectionResultValues,
  listInspectionTemplates,
  listInspections,
} from "../safety-permits.ts";
import {
  getRunOfShow,
  listCallSheets,
  listCalls,
  listCueCalls,
  listCues,
  listDaySheets,
} from "../show.ts";
import type { DocumentKind } from "./model.ts";
import type { DocumentDataMap, DocumentProject } from "./templates.ts";

/**
 * Loads the data of one document from the existing records, through the caller's own client, so
 * row level security decides what the document may show. Every record is checked against the org
 * the request names: a record of another org the caller also belongs to answers not found, so a
 * document never carries one org's record under another org's brand (ADR 0003).
 */

/** The project of a record, when it belongs to the org. */
export async function documentProject(
  db: XosClient,
  orgId: string,
  projectId: string,
): Promise<Result<DocumentProject>> {
  const { data, error } = await db
    .from("projects")
    .select("id, project_key, name, time_zone")
    .eq("id", projectId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok({
    id: data.id,
    key: data.project_key,
    name: data.name,
    timeZone: data.time_zone ?? "UTC",
  });
}

async function personNames(
  db: XosClient,
  ids: readonly (string | null)[],
): Promise<Result<ReadonlyMap<string, string>>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  if (wanted.length === 0) return ok(new Map());
  const { data, error } = await db.from("people").select("id, full_name").in("id", wanted);
  if (error) return fail(toDataError(error));
  return ok(new Map(data.flatMap((p) => (p.full_name ? [[p.id, p.full_name] as const] : []))));
}

type Loader<K extends DocumentKind> = (
  db: XosClient,
  orgId: string,
  id: string,
) => Promise<Result<DocumentDataMap[K]>>;

const LOADERS: { readonly [K in DocumentKind]: Loader<K> } = {
  "purchase-order": async (db, orgId, id) => {
    const order = await getPurchaseOrder(db, id);
    if (!order.ok) return order;
    const project = await documentProject(db, orgId, order.data.projectId);
    if (!project.ok) return project;
    const [lines, totals] = await Promise.all([
      listPoLines(db, id),
      getPurchaseOrderTotals(db, id),
    ]);
    if (!lines.ok) return lines;
    if (!totals.ok) return totals;
    return ok({ project: project.data, order: order.data, lines: lines.data, totals: totals.data });
  },

  invoice: async (db, orgId, id) => {
    const found = await listInvoices(db, { orgId, id });
    if (!found.ok) return found;
    const invoice = found.data[0];
    if (!invoice) return fail({ kind: "not-found" });
    const project = await documentProject(db, orgId, invoice.projectId);
    if (!project.ok) return project;
    const lines = await listInvoiceLines(db, id);
    if (!lines.ok) return lines;
    let counterpartyName: string | null = null;
    if (invoice.counterpartyId) {
      const { data, error } = await db
        .from("counterparties")
        .select("counterparty_name")
        .eq("id", invoice.counterpartyId)
        .maybeSingle();
      if (error) return fail(toDataError(error));
      counterpartyName = data?.counterparty_name ?? null;
    }
    return ok({ project: project.data, invoice, lines: lines.data, counterpartyName });
  },

  "change-order": async (db, orgId, id) => {
    const found = await listChangeOrders(db, { orgId, id });
    if (!found.ok) return found;
    const order = found.data[0];
    if (!order) return fail({ kind: "not-found" });
    const project = await documentProject(db, orgId, order.projectId);
    if (!project.ok) return project;
    const [lines, budget] = await Promise.all([
      listChangeOrderLines(db, id),
      db.from("budgets").select("name, currency_code").eq("id", order.budgetId).maybeSingle(),
    ]);
    if (!lines.ok) return lines;
    if (budget.error) return fail(toDataError(budget.error));
    return ok({
      project: project.data,
      order,
      lines: lines.data,
      budgetName: budget.data?.name ?? null,
      currency: (budget.data?.currency_code ?? "USD").trim(),
    });
  },

  "day-sheet": async (db, orgId, id) => {
    const found = await listDaySheets(db, { orgId, id });
    if (!found.ok) return found;
    const sheet = found.data[0];
    if (!sheet) return fail({ kind: "not-found" });
    const project = await documentProject(db, orgId, sheet.projectId);
    if (!project.ok) return project;
    return ok({ project: project.data, sheet });
  },

  "call-sheet": async (db, orgId, id) => {
    const found = await listCallSheets(db, { orgId, id });
    if (!found.ok) return found;
    const sheet = found.data[0];
    if (!sheet) return fail({ kind: "not-found" });
    const project = await documentProject(db, orgId, sheet.projectId);
    if (!project.ok) return project;
    const calls = await listCalls(db, {
      projectId: sheet.projectId,
      day: sheet.day,
      timeZone: project.data.timeZone,
    });
    if (!calls.ok) return calls;
    return ok({ project: project.data, sheet, calls: calls.data });
  },

  "run-of-show": async (db, orgId, id) => {
    const run = await getRunOfShow(db, id);
    if (!run.ok) return run;
    const project = await documentProject(db, orgId, run.data.projectId);
    if (!project.ok) return project;
    const [cues, calls] = await Promise.all([listCues(db, id), listCueCalls(db, id)]);
    if (!cues.ok) return cues;
    if (!calls.ok) return calls;
    return ok({ project: project.data, run: run.data, cues: cues.data, calls: calls.data });
  },

  beo: async (db, orgId, id) => {
    const beo = await getBeo(db, id);
    if (!beo.ok) return beo;
    const project = await documentProject(db, orgId, beo.data.projectId);
    if (!project.ok) return project;
    return ok({ project: project.data, beo: beo.data });
  },

  "credential-badge": async (db, orgId, id) => {
    const credential = await getIssuedCredential(db, id);
    if (!credential.ok) return credential;
    const project = await documentProject(db, orgId, credential.data.projectId);
    if (!project.ok) return project;
    return ok({ project: project.data, credential: credential.data });
  },

  "inspection-report": async (db, orgId, id) => {
    const found = await listInspections(db, { orgId, id, archive: "all" });
    if (!found.ok) return found;
    const inspection = found.data[0];
    if (!inspection) return fail({ kind: "not-found" });
    const project = await documentProject(db, orgId, inspection.projectId);
    if (!project.ok) return project;
    const [templates, values, names] = await Promise.all([
      listInspectionTemplates(db, orgId, "all"),
      listInspectionResultValues(db),
      personNames(db, [inspection.inspectorId, inspection.signedOffBy]),
    ]);
    if (!templates.ok) return templates;
    if (!values.ok) return values;
    if (!names.ok) return names;
    const template = templates.data.find((t) => t.id === inspection.templateId);
    return ok({
      project: project.data,
      inspection,
      templateName: template?.name ?? "",
      items: template?.items ?? [],
      resultCodes: Object.fromEntries(values.data.map((v) => [v.id, v.code])),
      inspectorName: inspection.inspectorId
        ? (names.data.get(inspection.inspectorId) ?? null)
        : null,
      signedOffByName: inspection.signedOffBy
        ? (names.data.get(inspection.signedOffBy) ?? null)
        : null,
    });
  },

  "incident-report": async (db, orgId, id) => {
    const incident = await getIncident(db, id);
    if (!incident.ok) return incident;
    const project = await documentProject(db, orgId, incident.data.projectId);
    if (!project.ok) return project;
    const [severities, history] = await Promise.all([
      listIncidentSeverities(db),
      listIncidentHistory(db, id),
    ]);
    if (!severities.ok) return severities;
    if (!history.ok) return history;
    return ok({
      project: project.data,
      incident: incident.data,
      severityLabel: severities.data.find((s) => s.id === incident.data.severityId)?.label ?? null,
      history: history.data,
    });
  },

  /** The final cost report is computed live for a project; its id is the project id. */
  "final-cost-report": async (db, orgId, id) => {
    const project = await documentProject(db, orgId, id);
    if (!project.ok) return project;
    const report = await finalCostReport(db, { orgId, projectId: id });
    if (!report.ok) return report;
    return ok({ project: project.data, report: report.data });
  },

  /** Only a signed agreement has a certificate; any other state answers not found. */
  "agreement-certificate": async (db, orgId, id) => {
    const owner = await db
      .from("agreements")
      .select("org_id")
      .eq("id", id)
      .eq("org_id", orgId)
      .maybeSingle();
    if (owner.error) return fail(toDataError(owner.error));
    if (!owner.data) return fail({ kind: "not-found" });
    const agreement = await getAgreement(db, id);
    if (!agreement.ok) return agreement;
    if (agreement.data.signedAt === null) return fail({ kind: "not-found" });
    let project: DocumentProject | null = null;
    if (agreement.data.projectId) {
      const found = await documentProject(db, orgId, agreement.data.projectId);
      if (!found.ok && found.error.kind !== "not-found") return found;
      project = found.ok ? found.data : null;
    }
    return ok({ project, agreement: agreement.data });
  },
};

export function loadDocumentData<K extends DocumentKind>(
  db: XosClient,
  orgId: string,
  kind: K,
  id: string,
): Promise<Result<DocumentDataMap[K]>> {
  return (LOADERS[kind] as Loader<K>)(db, orgId, id);
}
