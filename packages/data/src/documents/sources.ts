import type { XosClient } from "../client.ts";
import { getIssuedCredential } from "../credentials.ts";
import { badgePhotos, loadBadgePhotoBytes } from "../credential-photos.ts";
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
import { getRunOfShow, listCallSheets, listCalls, listCues, listDaySheets } from "../show.ts";
import { ATTACHMENTS_BUCKET } from "../attachments.ts";
import { getSitePlan, listSitePlans, listSitePlanShapes, type SitePlan } from "../places.ts";
import { listSigns, type Sign } from "../signage.ts";
import type { DocumentKind } from "./model.ts";
import { isEmbeddableImage } from "./render.ts";
import type { BadgePhoto, DocumentDataMap, DocumentProject } from "./templates.ts";

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

/**
 * The photo a badge prints, read as the caller (P5): the org's badge photo once Clean, else a profile photo the
 * caller may see. A credential that is no longer live, or a photo that cannot be read, prints the placeholder.
 */
export async function credentialBadgePhoto(
  db: XosClient,
  credentialId: string,
): Promise<BadgePhoto | null> {
  const rows = await badgePhotos(db, [credentialId]);
  if (!rows.ok) return null;
  return (await loadBadgePhotoBytes(db, rows.data)).get(credentialId) ?? null;
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

/** The most artwork bytes a build sheet embeds per sign (ADR 0140): a thumbnail, not a print file. */
export const MAX_ARTWORK_BYTES = 2 * 1024 * 1024;

/**
 * The bytes of a stored version read as the caller, when it is a Clean PNG or JPEG of a live attachment classified
 * Public or Internal and no larger than `maxBytes`; otherwise null. A document never embeds a file above Internal
 * (DOCUMENT_CLASSIFICATION), so a drawing or artwork raised later prints its frame or its name instead (ADR 0140 D3).
 */
export async function embeddableVersionBytes(
  db: XosClient,
  versionId: string,
  maxBytes = Number.POSITIVE_INFINITY,
): Promise<{ readonly bytes: Uint8Array | null; readonly filename: string }> {
  const { data } = await db
    .from("attachment_versions")
    .select(
      "object_name, filename, content_type, size_bytes, scan_status, deleted_at, attachments(classification, deleted_at)",
    )
    .eq("id", versionId)
    .maybeSingle();
  const row = data as unknown as {
    object_name: string;
    filename: string;
    content_type: string;
    size_bytes: number;
    scan_status: string;
    deleted_at: string | null;
    attachments: { classification: string; deleted_at: string | null } | null;
  } | null;
  if (!row) return { bytes: null, filename: "" };
  const drawable =
    row.deleted_at === null &&
    row.attachments?.deleted_at === null &&
    (row.attachments.classification === "Public" ||
      row.attachments.classification === "Internal") &&
    row.scan_status === "Clean" &&
    (row.content_type === "image/png" || row.content_type === "image/jpeg") &&
    row.size_bytes <= maxBytes;
  if (!drawable) return { bytes: null, filename: row.filename };
  const { data: blob } = await db.storage.from(ATTACHMENTS_BUCKET).download(row.object_name);
  const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  return { bytes: bytes && isEmbeddableImage(bytes) ? bytes : null, filename: row.filename };
}

/** The drawing a plan shows, when it is stored and still drawable; a legacy web image is never fetched. */
async function planDrawingBytes(db: XosClient, plan: SitePlan): Promise<Uint8Array | null> {
  if (!plan.drawing || plan.drawing.unavailable) return null;
  return (await embeddableVersionBytes(db, plan.drawing.shownVersionId)).bytes;
}

async function nameOf(db: XosClient, table: "venues" | "venue_levels", id: string | null) {
  if (!id) return null;
  const { data } = await db.from(table).select("name").eq("id", id).maybeSingle();
  return (data as { name: string } | null)?.name ?? null;
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
    const cues = await listCues(db, id);
    if (!cues.ok) return cues;
    return ok({ project: project.data, run: run.data, cues: cues.data });
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
    return ok({
      project: project.data,
      credential: credential.data,
      photo: await credentialBadgePhoto(db, id),
    });
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

  /** A live site plan of the org (B1): its drawing as shown, its shapes and the signs at its pins. */
  "site-plan": async (db, orgId, id) => {
    const plan = await getSitePlan(db, id);
    if (!plan.ok) return plan;
    if (plan.data.archivedAt !== null) return fail({ kind: "not-found" });
    const project = await documentProject(db, orgId, plan.data.projectId);
    if (!project.ok) return project;
    const [shapes, signs, venueName, levelName, drawing] = await Promise.all([
      listSitePlanShapes(db, [id]),
      listSigns(db, { orgId, projectId: plan.data.projectId }),
      nameOf(db, "venues", plan.data.venueId),
      nameOf(db, "venue_levels", plan.data.venueLevelId),
      planDrawingBytes(db, plan.data),
    ]);
    if (!shapes.ok) return shapes;
    if (!signs.ok) return signs;
    const signsAtPins: Record<string, string[]> = {};
    for (const sign of signs.data) {
      if (!sign.sitePlanPinId) continue;
      (signsAtPins[sign.sitePlanPinId] ??= []).push(`${sign.key} ${sign.title}`);
    }
    return ok({
      project: project.data,
      plan: plan.data,
      venueName,
      levelName,
      shapes: shapes.data,
      drawing,
      signsAtPins,
    });
  },

  /** The signage build sheet of a project (B1); its id is the project id. */
  "signage-build-sheet": async (db, orgId, id) => {
    const project = await documentProject(db, orgId, id);
    if (!project.ok) return project;
    const [signs, plans] = await Promise.all([
      listSigns(db, { orgId, projectId: id }),
      listSitePlans(db, { orgId, projectId: id }),
    ]);
    if (!signs.ok) return signs;
    if (!plans.ok) return plans;
    const pinned = new Set(
      signs.data.map((s) => s.sitePlanPinId).filter((p): p is string => p !== null),
    );
    const holding = plans.data
      .filter((p) => p.pins.some((pin) => pinned.has(pin.id)))
      .sort((a, b) => a.title.localeCompare(b.title));
    const withArt = signs.data.filter(
      (s): s is Sign & { artworkVersionId: string } => s.artworkVersionId !== null,
    );
    const [drawings, art] = await Promise.all([
      Promise.all(holding.map((plan) => planDrawingBytes(db, plan))),
      Promise.all(
        withArt.map((s) => embeddableVersionBytes(db, s.artworkVersionId, MAX_ARTWORK_BYTES)),
      ),
    ]);
    return ok({
      project: project.data,
      signs: signs.data,
      plans: holding.map((plan, i) => ({ plan, drawing: drawings[i] ?? null })),
      artwork: Object.fromEntries(
        withArt.map((s, i) => [s.id, art[i] ?? { bytes: null, filename: "" }]),
      ),
    });
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
