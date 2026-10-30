import type { XosClient } from "../client.ts";
import { readView } from "../gateway-operations.ts";
import { fail, ok, type Result } from "../result.ts";
import { intervalSeconds } from "../show.ts";
import type { DocumentKind } from "./model.ts";
import type { DocumentDataMap, DocumentProject } from "./templates.ts";

/**
 * Document data for Gateway (ADR 0031). External parties read records only through the
 * api_external views, which already limit rows to what the caller's engagement or account may see;
 * these loaders read the same views Gateway's tabs show and map them onto the template data, so a
 * vendor, client or crew member downloads exactly the record their tab lists. The views carry no
 * project key, so keys fall back to the record's own number.
 */

/** The documents Gateway offers: the records its engagement tabs list. */
export const EXTERNAL_DOCUMENT_KINDS = [
  "purchase-order",
  "invoice",
  "change-order",
  "run-of-show",
  "credential-badge",
] as const satisfies readonly DocumentKind[];

export type ExternalDocumentKind = (typeof EXTERNAL_DOCUMENT_KINDS)[number];

export function isExternalDocumentKind(kind: string): kind is ExternalDocumentKind {
  return (EXTERNAL_DOCUMENT_KINDS as readonly string[]).includes(kind);
}

export interface ExternalDocument<K extends ExternalDocumentKind> {
  readonly data: DocumentDataMap[K];
  readonly orgId: string;
  readonly orgName: string;
}

const NOT_FOUND = { kind: "not-found" } as const;

/** Sum of priced amounts, or null while any amount is unpriced or there are none. */
function strictTotal(amounts: readonly (number | null)[]): number | null {
  if (amounts.length === 0 || amounts.some((a) => a === null)) return null;
  return amounts.reduce<number>((sum, a) => sum + (a ?? 0), 0);
}

async function externalProject(
  db: XosClient,
  projectId: string,
  fallbackName: string | null,
): Promise<Result<DocumentProject & { orgId: string | null; orgName: string }>> {
  const [rows, engagements] = await Promise.all([
    readView(db, "projects", { eq: { id: projectId }, limit: 1 }),
    readView(db, "engagements", { eq: { project_id: projectId }, limit: 1 }),
  ]);
  if (!rows.ok) return rows;
  if (!engagements.ok) return engagements;
  const row = rows.data[0];
  return ok({
    id: projectId,
    key: "",
    name: row?.name ?? fallbackName ?? "",
    timeZone: row?.time_zone ?? "UTC",
    orgId: row?.org_id ?? null,
    orgName: engagements.data[0]?.org_name ?? "",
  });
}

type Loader<K extends ExternalDocumentKind> = (
  db: XosClient,
  id: string,
) => Promise<Result<ExternalDocument<K>>>;

const LOADERS: { readonly [K in ExternalDocumentKind]: Loader<K> } = {
  "purchase-order": async (db, id) => {
    const found = await readView(db, "purchase_orders", { eq: { id }, limit: 1 });
    if (!found.ok) return found;
    const po = found.data[0];
    if (!po?.id || !po.project_id || !po.org_id) return fail(NOT_FOUND);
    const [lines, project] = await Promise.all([
      readView(db, "po_lines", { eq: { purchase_order_id: id }, order: ["line_number", "asc"] }),
      externalProject(db, po.project_id, po.project_name),
    ]);
    if (!lines.ok) return lines;
    if (!project.ok) return project;
    const mapped = lines.data.map((l, i) => ({
      id: l.id ?? String(i),
      lineNumber: l.line_number ?? i + 1,
      description: l.description ?? "",
      elementId: l.element_id,
      budgetLineId: null,
      quantity: Number(l.quantity ?? 0),
      unitBasis: l.unit_basis,
      unitPriceMinor: l.unit_price_minor,
      extendedMinor: l.unit_price_minor === null ? null : l.amount_minor,
      receivedQuantity: 0,
    }));
    const number = po.po_number ?? 0;
    return ok({
      orgId: po.org_id,
      orgName: po.org_name ?? project.data.orgName,
      data: {
        project: project.data,
        order: {
          id,
          projectId: po.project_id,
          projectKey: null,
          number,
          key: `PO${number}`,
          vendorId: po.account_id ?? "",
          vendorName: null,
          rfqResponseId: null,
          currencyCode: (po.currency_code ?? "USD").trim(),
          state: po.po_state ?? "Sent",
          createdAt: po.sent_at ?? new Date(0).toISOString(),
          createdBy: null,
        },
        lines: mapped,
        totals: {
          unpricedCount: mapped.filter((l) => l.unitPriceMinor === null).length,
          linesTotalMinor: strictTotal(mapped.map((l) => l.extendedMinor)),
          approvedChangesMinor: null,
        },
      },
    });
  },

  invoice: async (db, id) => {
    const found = await readView(db, "invoices", { eq: { id }, limit: 1 });
    if (!found.ok) return found;
    const inv = found.data[0];
    if (!inv?.id || !inv.project_id || !inv.org_id) return fail(NOT_FOUND);
    const [lines, project] = await Promise.all([
      readView(db, "invoice_lines", { eq: { invoice_id: id }, order: ["line_number", "asc"] }),
      externalProject(db, inv.project_id, inv.project_name),
    ]);
    if (!lines.ok) return lines;
    if (!project.ok) return project;
    const mapped = lines.data.map((l, i) => ({
      id: l.id ?? String(i),
      lineNumber: l.line_number ?? i + 1,
      description: l.description ?? "",
      quantity: Number(l.quantity ?? 0),
      unitPriceMinor: l.unit_price_minor,
      budgetLineId: null,
      extendedMinor: l.unit_price_minor === null ? null : l.amount_minor,
    }));
    const subtotal = strictTotal(mapped.map((l) => l.extendedMinor));
    const total = inv.total_minor;
    return ok({
      orgId: inv.org_id,
      orgName: inv.org_name ?? project.data.orgName,
      data: {
        project: project.data,
        invoice: {
          id,
          projectId: inv.project_id,
          direction: inv.direction ?? "Payable",
          counterpartyId: null,
          payeePersonId: inv.payee_person_id,
          payeeName: null,
          engagementId: inv.engagement_id,
          number: inv.invoice_number,
          issuedOn: inv.issued_on,
          dueOn: inv.due_on,
          currency: (inv.currency_code ?? "USD").trim(),
          state: inv.invoice_state ?? "Issued",
          unpricedCount: mapped.filter((l) => l.unitPriceMinor === null).length,
          subtotalMinor: subtotal,
          taxMinor: subtotal === null || total === null ? null : total - subtotal,
          totalMinor: total,
          appliedMinor: inv.applied_minor ?? 0,
          createdAt: inv.issued_at ?? inv.submitted_at ?? new Date(0).toISOString(),
        },
        lines: mapped,
        counterpartyName: null,
      },
    });
  },

  "change-order": async (db, id) => {
    const found = await readView(db, "change_orders", { eq: { id }, limit: 1 });
    if (!found.ok) return found;
    const co = found.data[0];
    if (!co?.id || !co.project_id) return fail(NOT_FOUND);
    const [lines, project] = await Promise.all([
      readView(db, "change_order_lines", { eq: { change_order_id: id } }),
      externalProject(db, co.project_id, null),
    ]);
    if (!lines.ok) return lines;
    if (!project.ok) return project;
    if (!project.data.orgId) return fail(NOT_FOUND);
    // The view's key is {projectKey}-CO{number}; it restores both on the document.
    const match = /^(.*)-CO(\d+)$/.exec(co.change_order_key ?? "");
    const mapped = lines.data.map((l, i) => ({
      id: l.id ?? String(i),
      budgetLineId: null,
      description: l.description ?? "",
      urid: l.urid ?? "",
      quantity: Number(l.quantity ?? 0),
      unitPriceMinor: l.unit_price_minor,
      isNoCost: l.is_no_cost === true,
      extendedMinor: l.unit_price_minor === null ? null : l.amount_minor,
    }));
    return ok({
      orgId: project.data.orgId,
      orgName: project.data.orgName,
      data: {
        project: { ...project.data, key: match?.[1] ?? "" },
        order: {
          id,
          projectId: co.project_id,
          budgetId: "",
          number: Number(match?.[2] ?? 0),
          title: co.title ?? "",
          orderTypeId: null,
          reason: co.change_purpose,
          requestedBy: null,
          pricedBy: null,
          state: co.change_order_state ?? "Proposed",
          lineCount: mapped.length,
          unpricedCount: mapped.filter((l) => l.unitPriceMinor === null && !l.isNoCost).length,
          totalMinor: co.total_minor,
          createdAt: new Date(0).toISOString(),
        },
        lines: mapped,
        budgetName: null,
        currency: (co.currency_code ?? "USD").trim(),
      },
    });
  },

  "run-of-show": async (db, id) => {
    const found = await readView(db, "run_of_show", { eq: { id }, limit: 1 });
    if (!found.ok) return found;
    const run = found.data[0];
    if (!run?.id || !run.project_id) return fail(NOT_FOUND);
    const [cues, project] = await Promise.all([
      readView(db, "cues", { eq: { run_of_show_id: id }, order: ["position", "asc"] }),
      externalProject(db, run.project_id, run.project_name),
    ]);
    if (!cues.ok) return cues;
    if (!project.ok) return project;
    if (!project.data.orgId) return fail(NOT_FOUND);
    const mapped = cues.data.map((c, i) => ({
      id: c.id ?? String(i),
      runOfShowId: id,
      position: c.position ?? i + 1,
      label: c.label ?? "",
      plannedAt: c.planned_at,
      durationSeconds: intervalSeconds(c.duration === null ? null : String(c.duration)),
      calledAt: c.called_at,
      calledByName: null,
      startTbc: c.start_tbc === true,
      standbyAt: null,
    }));
    return ok({
      orgId: project.data.orgId,
      orgName: project.data.orgName,
      data: {
        project: project.data,
        run: {
          id,
          projectId: run.project_id,
          projectKey: "",
          projectName: project.data.name,
          timeZone: project.data.timeZone,
          scopeNodeId: null,
          name: run.name ?? "",
          showDate: run.show_date ?? "",
          cueCount: mapped.length,
          calledCount: mapped.filter((c) => c.calledAt !== null).length,
          curfewAt: null,
        },
        cues: mapped,
        // Department calls stay internal: no api_external view shows them (ADR 0131).
        calls: [],
      },
    });
  },

  "credential-badge": async (db, id) => {
    const found = await readView(db, "credentials", { eq: { id }, limit: 1 });
    if (!found.ok) return found;
    const c = found.data[0];
    if (!c?.id || !c.project_id || !c.valid_from) return fail(NOT_FOUND);
    const project = await externalProject(db, c.project_id, c.project_name);
    if (!project.ok) return project;
    if (!project.data.orgId) return fail(NOT_FOUND);
    return ok({
      orgId: project.data.orgId,
      orgName: project.data.orgName,
      data: {
        project: project.data,
        credential: {
          id,
          number: c.credential_number ?? "",
          holderPersonId: c.holder_person_id ?? "",
          holderName: c.holder_name,
          categoryId: "",
          categoryCode: c.category_code ?? "",
          categoryName: c.category_name ?? "",
          projectId: c.project_id,
          projectKey: "",
          issuedByName: null,
          validFrom: c.valid_from,
          validTo: c.valid_to,
          revokedAt: c.revoked_at,
          revokedByName: null,
          createdAt: c.valid_from,
          updatedAt: c.valid_from,
        },
      },
    });
  },
};

export function loadExternalDocumentData<K extends ExternalDocumentKind>(
  db: XosClient,
  kind: K,
  id: string,
): Promise<Result<ExternalDocument<K>>> {
  return (LOADERS[kind] as Loader<K>)(db, id);
}
