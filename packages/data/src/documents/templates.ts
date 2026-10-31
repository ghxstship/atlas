import { credentialStatus, type IssuedCredential } from "../credentials.ts";
import type { RadioHandoutLine } from "../allocations.ts";
import type { ChangeOrder, ChangeOrderLine, Invoice, InvoiceLine } from "../finance.ts";
import type { BeoDetail } from "../hospitality.ts";
import type { Incident, IncidentTransition } from "../incidents.ts";
import type { AgreementDetail } from "../people.ts";
import type { PoLine, PurchaseOrder, PurchaseOrderTotals } from "../procurement.ts";
import type { FinalCostReport, FinalCostRow } from "../reports.ts";
import type { Inspection, InspectionItem } from "../safety-permits.ts";
import { callLines, CUE_CALL_SLUGS } from "../cue-calls.ts";
import type { Call, CallSheet, Cue, CueCall, DaySheet, RunOfShow } from "../show.ts";
import type { Formatter, Translate } from "./format.ts";
import type { DocumentBlock, DocumentKind } from "./model.ts";

/**
 * Versioned templates for the twelve Section 11.9 documents and the radio hand-out (ADR 0031). Each kind keeps every
 * version it has shipped. A record renders with the version in force when it was issued, so a
 * re-render of an old record looks the way it did then; a template change ships as a new version
 * with a later `effectiveFrom`, never as an edit to a shipped one.
 */

export interface DocumentProject {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly timeZone: string;
}

/** The record data each template reads, loaded as the caller (sources.ts). */
export interface DocumentDataMap {
  "purchase-order": {
    readonly project: DocumentProject;
    readonly order: PurchaseOrder;
    readonly lines: readonly PoLine[];
    readonly totals: PurchaseOrderTotals;
  };
  invoice: {
    readonly project: DocumentProject;
    readonly invoice: Invoice;
    readonly lines: readonly InvoiceLine[];
    readonly counterpartyName: string | null;
  };
  "change-order": {
    readonly project: DocumentProject;
    readonly order: ChangeOrder;
    readonly lines: readonly ChangeOrderLine[];
    readonly budgetName: string | null;
    readonly currency: string;
  };
  "day-sheet": { readonly project: DocumentProject; readonly sheet: DaySheet };
  "call-sheet": {
    readonly project: DocumentProject;
    readonly sheet: CallSheet;
    readonly calls: readonly Call[];
  };
  "run-of-show": {
    readonly project: DocumentProject;
    readonly run: RunOfShow;
    readonly cues: readonly Cue[];
    /** The cues' department calls (internal only; an external reader gets none). Read from version 2. */
    readonly calls?: readonly CueCall[];
  };
  beo: { readonly project: DocumentProject; readonly beo: BeoDetail };
  "credential-badge": { readonly project: DocumentProject; readonly credential: IssuedCredential };
  "inspection-report": {
    readonly project: DocumentProject;
    readonly inspection: Inspection;
    readonly templateName: string;
    readonly items: readonly InspectionItem[];
    /** Canon Inspection Result codes by enumeration id. */
    readonly resultCodes: Readonly<Record<string, string>>;
    readonly inspectorName: string | null;
    readonly signedOffByName: string | null;
  };
  "incident-report": {
    readonly project: DocumentProject;
    readonly incident: Incident;
    readonly severityLabel: string | null;
    readonly history: readonly IncidentTransition[];
  };
  "final-cost-report": { readonly project: DocumentProject; readonly report: FinalCostReport };
  "agreement-certificate": {
    readonly project: DocumentProject | null;
    readonly agreement: AgreementDetail;
  };
  /** A project's radio allocations, sorted by party then person (R7, G-91). */
  "radio-handout": {
    readonly project: DocumentProject;
    readonly lines: readonly RadioHandoutLine[];
  };
}

export type DocumentData = { [K in DocumentKind]: DocumentDataMap[K] }[DocumentKind];

export interface TemplateContext {
  readonly t: Translate;
  readonly f: Formatter;
  /** When the document is generated; also the issue time of a record that is computed live. */
  readonly generatedAt: Date;
}

export interface TemplateOutput {
  readonly title: string;
  readonly blocks: readonly DocumentBlock[];
}

export interface TemplateVersion<K extends DocumentKind> {
  readonly version: number;
  /** ISO instant from which a newly issued record of this kind uses this version. */
  readonly effectiveFrom: string;
  readonly build: (data: DocumentDataMap[K], ctx: TemplateContext) => TemplateOutput;
}

export type TemplateRegistry = { readonly [K in DocumentKind]: readonly TemplateVersion<K>[] };

/**
 * The version a record issued at `issuedAt` renders with: the latest whose `effectiveFrom` is not
 * after the issue time, or the first version for a record issued before any template existed.
 */
export function templateFor<K extends DocumentKind>(
  versions: readonly TemplateVersion<K>[],
  issuedAt: string,
): TemplateVersion<K> {
  const sorted = [...versions].sort((a, b) => a.version - b.version);
  const first = sorted[0];
  if (!first) throw new Error("A document kind needs at least one template version.");
  const at = Date.parse(issuedAt);
  if (Number.isNaN(at)) return sorted[sorted.length - 1] ?? first;
  let chosen = first;
  for (const v of sorted) if (Date.parse(v.effectiveFrom) <= at) chosen = v;
  return chosen;
}

/** A catalog key segment from a stored value ("Offer Letter" to "OfferLetter"). */
export const keyOf = (value: string) => value.replace(/[^A-Za-z0-9]/g, "");

/** How each record names itself on the page and when it was issued. Stable across versions. */
export const DESCRIBE: {
  readonly [K in DocumentKind]: (
    data: DocumentDataMap[K],
    generatedAt: Date,
  ) => { readonly recordKey: string; readonly issuedAt: string };
} = {
  "purchase-order": (d) => ({ recordKey: d.order.key, issuedAt: d.order.createdAt }),
  invoice: (d) => ({
    recordKey: d.invoice.number ?? keyed(d.project.key, `INV-${d.invoice.id.slice(0, 8)}`),
    issuedAt: d.invoice.issuedOn ? `${d.invoice.issuedOn}T00:00:00Z` : d.invoice.createdAt,
  }),
  "change-order": (d) => ({
    recordKey: keyed(d.project.key, `CO${d.order.number}`),
    issuedAt: d.order.createdAt,
  }),
  "day-sheet": (d) => ({
    recordKey: keyed(d.project.key, `DS-${d.sheet.day}`),
    issuedAt: d.sheet.publishedAt ?? d.sheet.updatedAt,
  }),
  "call-sheet": (d) => ({
    recordKey: keyed(d.project.key, `CS-${d.sheet.day}`),
    issuedAt: d.sheet.publishedAt ?? d.sheet.updatedAt,
  }),
  "run-of-show": (d) => ({
    recordKey: keyed(d.project.key, `ROS-${d.run.showDate}`),
    issuedAt: `${d.run.showDate}T00:00:00Z`,
  }),
  beo: (d) => ({ recordKey: d.beo.key, issuedAt: d.beo.approvedAt ?? d.beo.createdAt }),
  "credential-badge": (d) => ({
    recordKey: d.credential.number,
    issuedAt: d.credential.createdAt,
  }),
  "inspection-report": (d) => ({
    recordKey: keyed(d.project.key, `INS-${d.inspection.id.slice(0, 8)}`),
    issuedAt: d.inspection.signedOffAt ?? d.inspection.inspectedAt,
  }),
  "incident-report": (d) => ({ recordKey: d.incident.key, issuedAt: d.incident.createdAt }),
  "final-cost-report": (d, generatedAt) => ({
    recordKey: keyed(d.project.key, "FCR"),
    issuedAt: generatedAt.toISOString(),
  }),
  "agreement-certificate": (d) => ({
    recordKey: keyed(d.project?.key ?? "", `AGR-${d.agreement.id.slice(0, 8)}`),
    issuedAt: d.agreement.signedAt ?? d.agreement.createdAt,
  }),
  "radio-handout": (d, generatedAt) => ({
    recordKey: keyed(d.project.key, "RADIOS"),
    issuedAt: generatedAt.toISOString(),
  }),
};

const field = (label: string, value: string) => ({ label, value });

/** A project as "KEY Name"; Gateway's views carry no project key, so the key may be empty. */
export const projectLabel = (p: DocumentProject) => [p.key, p.name].filter(Boolean).join(" ");

/** A record key under its project key, or the bare key when the project key is not known. */
const keyed = (projectKey: string, rest: string) => (projectKey ? `${projectKey}-${rest}` : rest);
const yesNo = (t: Translate, value: boolean) => t(value ? "common.yes" : "common.no");

/** The money columns every priced line table shares. */
function lineColumns(t: Translate) {
  return [
    { label: t("common.lineNumber"), numeric: true, weight: 0.5 },
    { label: t("common.description"), weight: 4 },
    { label: t("common.quantity"), numeric: true },
    { label: t("common.unitPrice"), numeric: true, weight: 1.6 },
    { label: t("common.amount"), numeric: true, weight: 1.6 },
  ];
}

const V1 = "2026-01-01T00:00:00Z";
/**
 * Run of show version 2 (ADR 0131): TBC planned times, department calls and the curfew. It takes effect on the day
 * the release carrying it reaches production (00:00Z), which is set here when the release is cut.
 */
const RUN_OF_SHOW_V2 = "2026-10-31T00:00:00Z";

export const TEMPLATES: TemplateRegistry = {
  "purchase-order": [
    {
      version: 1,
      effectiveFrom: V1,
      build: ({ project, order, lines, totals }, { t, f }) => {
        const money = (m: number | null) => f.money(m, order.currencyCode);
        return {
          title: t("purchaseOrder.title", { key: order.key }),
          blocks: [
            {
              kind: "fields",
              caption: t("common.details"),
              fields: [
                field(t("purchaseOrder.vendor"), order.vendorName ?? t("common.none")),
                field(t("common.project"), projectLabel(project)),
                field(t("common.state"), t(`purchaseOrder.states.${keyOf(order.state)}`)),
                field(t("common.currency"), order.currencyCode),
                field(t("common.created"), f.dateTime(order.createdAt)),
              ],
            },
            {
              kind: "table",
              caption: t("common.lines"),
              columns: [...lineColumns(t), { label: t("purchaseOrder.received"), numeric: true }],
              rows: lines.map((l) => [
                String(l.lineNumber),
                l.description,
                f.number(l.quantity),
                money(l.unitPriceMinor),
                money(l.extendedMinor),
                f.number(l.receivedQuantity),
              ]),
              footer: [
                ["", t("common.total"), "", "", money(totals.linesTotalMinor), ""],
                [
                  "",
                  t("purchaseOrder.approvedChanges"),
                  "",
                  "",
                  totals.approvedChangesMinor === null
                    ? t("common.none")
                    : money(totals.approvedChangesMinor),
                  "",
                ],
              ],
              empty: t("common.noLines"),
            },
            ...(totals.unpricedCount > 0
              ? [
                  {
                    kind: "paragraph" as const,
                    text: t("common.unpricedNote", { count: totals.unpricedCount }),
                  },
                ]
              : []),
          ],
        };
      },
    },
  ],
  invoice: [
    {
      version: 1,
      effectiveFrom: V1,
      build: ({ project, invoice, lines, counterpartyName }, { t, f }) => {
        const money = (m: number | null) => f.money(m, invoice.currency);
        const key = DESCRIBE.invoice(
          { project, invoice, lines, counterpartyName },
          new Date(),
        ).recordKey;
        const balance =
          invoice.totalMinor === null ? null : invoice.totalMinor - invoice.appliedMinor;
        return {
          title: t("invoice.title", { key }),
          blocks: [
            {
              kind: "fields",
              caption: t("common.details"),
              fields: [
                field(
                  t(`invoice.party.${keyOf(invoice.direction)}`),
                  counterpartyName ?? invoice.payeeName ?? t("common.none"),
                ),
                field(t("invoice.direction"), t(`invoice.directions.${keyOf(invoice.direction)}`)),
                field(t("invoice.number"), invoice.number ?? t("common.none")),
                field(t("common.project"), projectLabel(project)),
                field(t("common.state"), t(`invoice.states.${keyOf(invoice.state)}`)),
                field(t("invoice.issuedOn"), f.day(invoice.issuedOn)),
                field(t("invoice.dueOn"), f.day(invoice.dueOn)),
              ],
            },
            {
              kind: "table",
              caption: t("common.lines"),
              columns: lineColumns(t),
              rows: lines.map((l) => [
                String(l.lineNumber),
                l.description,
                f.number(l.quantity),
                money(l.unitPriceMinor),
                money(l.extendedMinor),
              ]),
              footer: [
                ["", t("invoice.subtotal"), "", "", money(invoice.subtotalMinor)],
                ["", t("invoice.tax"), "", "", money(invoice.taxMinor)],
                ["", t("common.total"), "", "", money(invoice.totalMinor)],
                ["", t("invoice.applied"), "", "", money(invoice.appliedMinor)],
                ["", t("invoice.balance"), "", "", money(balance)],
              ],
              empty: t("common.noLines"),
            },
            ...(invoice.unpricedCount > 0
              ? [
                  {
                    kind: "paragraph" as const,
                    text: t("common.unpricedNote", { count: invoice.unpricedCount }),
                  },
                ]
              : []),
          ],
        };
      },
    },
  ],
  "change-order": [
    {
      version: 1,
      effectiveFrom: V1,
      build: ({ project, order, lines, budgetName, currency }, { t, f }) => {
        const money = (m: number | null) => f.money(m, currency);
        return {
          title: t("changeOrder.title", { key: keyed(project.key, `CO${order.number}`) }),
          blocks: [
            { kind: "paragraph", text: order.title, size: "body" },
            {
              kind: "fields",
              caption: t("common.details"),
              fields: [
                field(t("common.project"), projectLabel(project)),
                field(t("changeOrder.budget"), budgetName ?? t("common.none")),
                field(t("common.state"), t(`changeOrder.states.${keyOf(order.state)}`)),
                field(t("changeOrder.reason"), order.reason ?? t("common.none")),
                field(t("common.created"), f.dateTime(order.createdAt)),
              ],
            },
            {
              kind: "table",
              caption: t("common.lines"),
              columns: [
                { label: t("common.description"), weight: 4 },
                { label: t("changeOrder.urid"), weight: 1.4 },
                { label: t("common.quantity"), numeric: true },
                { label: t("common.unitPrice"), numeric: true, weight: 1.6 },
                { label: t("common.amount"), numeric: true, weight: 1.6 },
              ],
              rows: lines.map((l) => [
                l.description,
                l.urid,
                f.number(l.quantity),
                l.isNoCost ? t("changeOrder.noCost") : money(l.unitPriceMinor),
                l.isNoCost ? t("changeOrder.noCost") : money(l.extendedMinor),
              ]),
              footer: [["", "", "", t("common.total"), money(order.totalMinor)]],
              empty: t("common.noLines"),
            },
            ...(order.unpricedCount > 0
              ? [
                  {
                    kind: "paragraph" as const,
                    text: t("common.unpricedNote", { count: order.unpricedCount }),
                  },
                ]
              : []),
          ],
        };
      },
    },
  ],
  "day-sheet": [
    {
      version: 1,
      effectiveFrom: V1,
      build: ({ project, sheet }, { t, f }) => ({
        title: t("daySheet.title", { project: project.key, day: f.day(sheet.day) }),
        blocks: [
          {
            kind: "fields",
            caption: t("common.details"),
            fields: [
              field(t("common.project"), projectLabel(project)),
              field(t("common.day"), f.day(sheet.day)),
              field(
                t("common.published"),
                sheet.publishedAt ? f.dateTime(sheet.publishedAt) : t("common.draft"),
              ),
            ],
          },
          { kind: "heading", text: t("daySheet.body") },
          {
            kind: "paragraph",
            text: sheet.body.trim() === "" ? t("daySheet.emptyBody") : sheet.body,
          },
        ],
      }),
    },
  ],
  "call-sheet": [
    {
      version: 1,
      effectiveFrom: V1,
      build: ({ project, sheet, calls }, { t, f }) => ({
        title: t("callSheet.title", { project: project.key, day: f.day(sheet.day) }),
        blocks: [
          {
            kind: "fields",
            caption: t("common.details"),
            fields: [
              field(t("common.project"), projectLabel(project)),
              field(t("common.day"), f.day(sheet.day)),
              field(t("common.timeZone"), f.timeZone),
              field(
                t("common.published"),
                sheet.publishedAt ? f.dateTime(sheet.publishedAt) : t("common.draft"),
              ),
            ],
          },
          {
            kind: "table",
            caption: t("callSheet.calls"),
            columns: [
              { label: t("callSheet.callTime") },
              { label: t("callSheet.ends") },
              { label: t("callSheet.role"), weight: 2.4 },
              { label: t("callSheet.person"), weight: 2.4 },
            ],
            rows: calls.map((c) => [
              f.time(c.startsAt),
              f.time(c.endsAt),
              [c.roleTitle, c.roleCode ? `(${c.roleCode})` : null].filter(Boolean).join(" ") ||
                t("common.none"),
              c.personName ?? t("callSheet.unfilled"),
            ]),
            empty: t("callSheet.noCalls"),
          },
        ],
      }),
    },
  ],
  "run-of-show": [
    {
      version: 1,
      effectiveFrom: V1,
      build: ({ project, run, cues }, { t, f }) => ({
        title: t("runOfShow.title", { name: run.name }),
        blocks: [
          {
            kind: "fields",
            caption: t("common.details"),
            fields: [
              field(t("common.project"), projectLabel(project)),
              field(t("runOfShow.showDate"), f.day(run.showDate)),
              field(t("common.timeZone"), f.timeZone),
              field(
                t("runOfShow.progress"),
                t("runOfShow.called", { called: run.calledCount, count: run.cueCount }),
              ),
            ],
          },
          {
            kind: "table",
            caption: t("runOfShow.cues"),
            columns: [
              { label: t("common.lineNumber"), numeric: true, weight: 0.5 },
              { label: t("runOfShow.cue"), weight: 3.5 },
              { label: t("runOfShow.plannedAt"), weight: 1.2 },
              { label: t("runOfShow.duration"), numeric: true },
              { label: t("runOfShow.calledAt"), weight: 1.2 },
              { label: t("runOfShow.calledBy"), weight: 1.8 },
            ],
            rows: cues.map((c, i) => [
              String(i + 1),
              c.label,
              f.time(c.plannedAt),
              f.duration(c.durationSeconds),
              c.calledAt ? f.time(c.calledAt) : t("runOfShow.notCalled"),
              c.calledByName ?? t("common.none"),
            ]),
            empty: t("runOfShow.noCues"),
          },
        ],
      }),
    },
    {
      version: 2,
      effectiveFrom: RUN_OF_SHOW_V2,
      build: ({ project, run, cues, calls = [] }, { t, f }) => ({
        title: t("runOfShow.title", { name: run.name }),
        blocks: [
          {
            kind: "fields",
            caption: t("common.details"),
            fields: [
              field(t("common.project"), projectLabel(project)),
              field(t("runOfShow.showDate"), f.day(run.showDate)),
              field(t("common.timeZone"), f.timeZone),
              ...(run.curfewAt ? [field(t("runOfShow.curfew"), f.dateTime(run.curfewAt))] : []),
              field(
                t("runOfShow.progress"),
                t("runOfShow.called", { called: run.calledCount, count: run.cueCount }),
              ),
            ],
          },
          {
            kind: "table",
            caption: t("runOfShow.cues"),
            columns: [
              { label: t("common.lineNumber"), numeric: true, weight: 0.5 },
              { label: t("runOfShow.cue"), weight: 2.4 },
              { label: t("runOfShow.plannedAt"), weight: 1.2 },
              { label: t("runOfShow.duration"), numeric: true },
              { label: t("runOfShow.departmentCalls"), weight: 3 },
              { label: t("runOfShow.calledAt"), weight: 1.2 },
              { label: t("runOfShow.calledBy"), weight: 1.6 },
            ],
            rows: cues.map((c, i) => [
              String(i + 1),
              c.label,
              c.startTbc && c.plannedAt ? t("runOfShow.tbc") : f.time(c.plannedAt),
              f.duration(c.durationSeconds),
              callLines(
                calls.filter((call) => call.cueId === c.id),
                null,
              )
                .map((line) =>
                  t("runOfShow.departmentCall", {
                    department: t(`runOfShow.departments.${CUE_CALL_SLUGS[line.kind]}`),
                    instruction: line.instruction,
                  }),
                )
                .join("\n"),
              c.calledAt ? f.time(c.calledAt) : t("runOfShow.notCalled"),
              c.calledByName ?? t("common.none"),
            ]),
            empty: t("runOfShow.noCues"),
          },
        ],
      }),
    },
  ],
  beo: [
    {
      version: 1,
      effectiveFrom: V1,
      build: ({ project, beo }, { t, f }) => {
        const currency = beo.total.currencyCode ?? beo.lines[0]?.currencyCode ?? "USD";
        return {
          title: t("beo.title", { key: beo.key }),
          blocks: [
            {
              kind: "fields",
              caption: t("common.details"),
              fields: [
                field(t("common.project"), projectLabel(project)),
                field(t("beo.eventAt"), f.dateTime(beo.eventAt)),
                field(
                  t("beo.guests"),
                  beo.guestCount === null ? t("common.none") : f.number(beo.guestCount),
                ),
                field(t("beo.fulfillment"), beo.fulfillmentTitle ?? t("common.none")),
                field(
                  t("beo.approval"),
                  beo.approvedAt
                    ? t("beo.approvedBy", {
                        name: beo.approvedByName ?? t("common.none"),
                        at: f.dateTime(beo.approvedAt),
                      })
                    : t("beo.notApproved"),
                ),
              ],
            },
            {
              kind: "table",
              caption: t("common.lines"),
              columns: lineColumns(t),
              rows: beo.lines.map((l, i) => [
                String(i + 1),
                l.description,
                f.number(l.quantity),
                f.money(l.unitPriceMinor, l.currencyCode ?? currency),
                f.money(l.amountMinor, l.currencyCode ?? currency),
              ]),
              footer: [
                [
                  "",
                  t("common.total"),
                  "",
                  "",
                  beo.total.mixedCurrencies
                    ? t("common.mixedCurrencies")
                    : f.money(beo.total.amountMinor, currency),
                ],
              ],
              empty: t("common.noLines"),
            },
            ...(beo.total.unpricedCount > 0
              ? [
                  {
                    kind: "paragraph" as const,
                    text: t("common.unpricedNote", { count: beo.total.unpricedCount }),
                  },
                ]
              : []),
          ],
        };
      },
    },
  ],
  "credential-badge": [
    {
      version: 1,
      effectiveFrom: V1,
      build: ({ project, credential }, { t, f, generatedAt }) => ({
        title: t("credentialBadge.title", { category: credential.categoryName }),
        blocks: [
          {
            kind: "paragraph",
            text: credential.holderName ?? t("common.none"),
            size: "large",
          },
          {
            kind: "fields",
            caption: t("common.details"),
            fields: [
              field(
                t("credentialBadge.category"),
                `${credential.categoryName} (${credential.categoryCode})`,
              ),
              field(t("credentialBadge.number"), credential.number),
              field(t("common.project"), projectLabel(project)),
              field(t("credentialBadge.validFrom"), f.dateTime(credential.validFrom)),
              field(
                t("credentialBadge.validTo"),
                credential.validTo ? f.dateTime(credential.validTo) : t("credentialBadge.noEnd"),
              ),
              field(
                t("common.state"),
                t(`credentialBadge.statuses.${credentialStatus(credential, generatedAt)}`),
              ),
              field(t("credentialBadge.issuedBy"), credential.issuedByName ?? t("common.none")),
            ],
          },
          { kind: "paragraph", text: t("credentialBadge.scanNote") },
        ],
      }),
    },
  ],
  "inspection-report": [
    {
      version: 1,
      effectiveFrom: V1,
      build: (d, { t, f }) => {
        const results = new Map(d.inspection.results.map((r) => [r.itemId, r]));
        return {
          title: t("inspectionReport.title", { template: d.templateName }),
          blocks: [
            {
              kind: "fields",
              caption: t("common.details"),
              fields: [
                field(t("common.project"), projectLabel(d.project)),
                field(t("inspectionReport.template"), d.templateName),
                field(t("inspectionReport.inspectedAt"), f.dateTime(d.inspection.inspectedAt)),
                field(t("inspectionReport.inspector"), d.inspectorName ?? t("common.none")),
                field(
                  t("inspectionReport.signOff"),
                  d.inspection.signedOffAt
                    ? t("inspectionReport.signedOffBy", {
                        name: d.signedOffByName ?? t("common.none"),
                        at: f.dateTime(d.inspection.signedOffAt),
                      })
                    : t("inspectionReport.notSignedOff"),
                ),
              ],
            },
            {
              kind: "table",
              caption: t("inspectionReport.items"),
              columns: [
                { label: t("common.lineNumber"), numeric: true, weight: 0.5 },
                { label: t("inspectionReport.prompt"), weight: 4 },
                { label: t("inspectionReport.critical") },
                { label: t("inspectionReport.result"), weight: 1.8 },
                { label: t("inspectionReport.note"), weight: 2.5 },
              ],
              rows: d.items.map((item, i) => {
                const r = results.get(item.id);
                const code = r ? d.resultCodes[r.resultEnumId] : undefined;
                return [
                  String(i + 1),
                  item.prompt,
                  yesNo(t, item.critical),
                  code ? t(`inspectionReport.results.${keyOf(code)}`) : t("inspectionReport.open"),
                  r?.note ?? "",
                ];
              }),
              empty: t("inspectionReport.noItems"),
            },
          ],
        };
      },
    },
  ],
  "incident-report": [
    {
      version: 1,
      effectiveFrom: V1,
      build: ({ project, incident, severityLabel, history }, { t, f }) => ({
        title: t("incidentReport.title", { key: incident.key }),
        blocks: [
          { kind: "paragraph", text: incident.title },
          {
            kind: "fields",
            caption: t("common.details"),
            fields: [
              field(t("common.project"), projectLabel(project)),
              field(t("incidentReport.severity"), severityLabel ?? t("common.none")),
              field(t("common.state"), t(`incidentReport.states.${keyOf(incident.state)}`)),
              field(t("incidentReport.occurredAt"), f.dateTime(incident.occurredAt)),
              field(
                t("incidentReport.zone"),
                incident.zoneName
                  ? `${incident.zoneName}${incident.zoneCode ? ` (${incident.zoneCode})` : ""}`
                  : t("common.none"),
              ),
              field(t("incidentReport.reportedBy"), incident.reportedByName ?? t("common.none")),
              field(t("incidentReport.responders"), f.number(incident.responderCount)),
              field(
                t("incidentReport.location"),
                incident.latitude !== null && incident.longitude !== null
                  ? `${incident.latitude.toFixed(5)}, ${incident.longitude.toFixed(5)}`
                  : t("common.none"),
              ),
              field(
                t("incidentReport.closedBy"),
                incident.closedSignedOffByName ?? t("common.none"),
              ),
            ],
          },
          {
            kind: "table",
            caption: t("incidentReport.history"),
            columns: [
              { label: t("incidentReport.when"), weight: 1.6 },
              { label: t("incidentReport.change"), weight: 1.8 },
              { label: t("incidentReport.by"), weight: 1.4 },
              { label: t("incidentReport.reason"), weight: 3 },
            ],
            rows: history.map((h) => [
              f.dateTime(h.at),
              h.fromState
                ? t("incidentReport.moved", {
                    from: t(`incidentReport.states.${keyOf(h.fromState)}`),
                    to: t(`incidentReport.states.${keyOf(h.toState)}`),
                  })
                : t(`incidentReport.states.${keyOf(h.toState)}`),
              h.byName ?? t("common.none"),
              h.reason,
            ]),
            empty: t("incidentReport.noHistory"),
          },
        ],
      }),
    },
  ],
  "final-cost-report": [
    {
      version: 1,
      effectiveFrom: V1,
      build: ({ project, report }, { t, f }) => {
        const row = (r: FinalCostRow, label?: string) => [
          label ?? r.accountCode,
          f.money(r.baselineMinor, r.currency),
          f.money(r.approvedChangeMinor, r.currency),
          f.money(r.revisedMinor, r.currency),
          f.money(r.actualMinor, r.currency),
          f.money(r.varianceMinor, r.currency),
        ];
        return {
          title: t("finalCostReport.title", { project: project.key }),
          blocks: [
            {
              kind: "fields",
              caption: t("common.details"),
              fields: [
                field(t("common.project"), projectLabel(project)),
                field(t("finalCostReport.basis"), t("finalCostReport.basisValue")),
              ],
            },
            report.hasBaseline
              ? {
                  kind: "table",
                  caption: t("finalCostReport.byAccount"),
                  columns: [
                    { label: t("finalCostReport.account"), weight: 1.2 },
                    { label: t("finalCostReport.baseline"), numeric: true, weight: 1.5 },
                    { label: t("finalCostReport.changes"), numeric: true, weight: 1.5 },
                    { label: t("finalCostReport.revised"), numeric: true, weight: 1.5 },
                    { label: t("finalCostReport.actual"), numeric: true, weight: 1.5 },
                    { label: t("finalCostReport.variance"), numeric: true, weight: 1.5 },
                  ],
                  rows: report.rows.map((r) => row(r)),
                  footer: report.totals.map((r) =>
                    row(r, t("finalCostReport.totalIn", { currency: r.currency })),
                  ),
                  empty: t("finalCostReport.noRows"),
                }
              : { kind: "paragraph", text: t("finalCostReport.noBaseline") },
          ],
        };
      },
    },
  ],
  "agreement-certificate": [
    {
      version: 1,
      effectiveFrom: V1,
      build: ({ project, agreement }, { t, f }) => ({
        title: t("agreementCertificate.title"),
        blocks: [
          { kind: "paragraph", text: agreement.title },
          {
            kind: "fields",
            caption: t("agreementCertificate.signature"),
            fields: [
              field(
                t("agreementCertificate.kind"),
                t(`agreementCertificate.kinds.${keyOf(agreement.kind)}`),
              ),
              field(t("common.project"), project ? projectLabel(project) : t("common.none")),
              field(t("agreementCertificate.signer"), agreement.personName ?? t("common.none")),
              field(t("agreementCertificate.signedName"), agreement.signedName ?? t("common.none")),
              field(t("agreementCertificate.signedAt"), f.dateTime(agreement.signedAt)),
              field(t("common.state"), t(`agreementCertificate.states.${keyOf(agreement.state)}`)),
              field(t("agreementCertificate.hash"), agreement.signedBodySha256 ?? t("common.none")),
            ],
          },
          { kind: "paragraph", text: t("agreementCertificate.statement") },
          {
            kind: "table",
            caption: t("agreementCertificate.ledger"),
            columns: [
              { label: t("agreementCertificate.when"), weight: 1.6 },
              { label: t("agreementCertificate.change"), weight: 1.8 },
              { label: t("agreementCertificate.reason"), weight: 3 },
            ],
            rows: [...agreement.transitions]
              .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
              .map((tr) => [
                f.dateTime(tr.at),
                tr.fromState
                  ? t("agreementCertificate.moved", {
                      from: t(`agreementCertificate.states.${keyOf(tr.fromState)}`),
                      to: t(`agreementCertificate.states.${keyOf(tr.toState)}`),
                    })
                  : t(`agreementCertificate.states.${keyOf(tr.toState)}`),
                tr.reason,
              ]),
            empty: t("agreementCertificate.noLedger"),
          },
          { kind: "heading", text: t("agreementCertificate.text") },
          { kind: "paragraph", text: agreement.body },
        ],
      }),
    },
  ],
  "radio-handout": [
    {
      version: 1,
      effectiveFrom: V1,
      build: ({ project, lines }, { t, f, generatedAt }) => ({
        title: t("radioHandout.title"),
        blocks: [
          {
            kind: "paragraph",
            text: t("radioHandout.subtitle", {
              project: projectLabel(project),
              date: f.dateTime(generatedAt.toISOString()),
            }),
          },
          {
            kind: "table",
            caption: t("radioHandout.title"),
            columns: [
              { label: t("radioHandout.person"), weight: 2 },
              { label: t("radioHandout.party"), weight: 2 },
              { label: t("radioHandout.radio"), weight: 1.6 },
              { label: t("radioHandout.tags"), weight: 1.6 },
              { label: t("radioHandout.channels"), weight: 2 },
              { label: t("radioHandout.status"), weight: 1.2 },
              { label: t("radioHandout.signature"), weight: 1.6 },
              { label: t("radioHandout.returned"), weight: 1 },
            ],
            rows: [...lines]
              .sort(
                (a, b) =>
                  a.partyName.localeCompare(b.partyName) ||
                  a.personName.localeCompare(b.personName),
              )
              .map((l) => [
                l.personName || l.partyName,
                l.partyName,
                l.quantity === 1 ? l.className : `${l.className} × ${f.number(l.quantity)}`,
                l.tagsIssued.length > 0 ? l.tagsIssued.join(", ") : t("common.none"),
                l.channelNumbers.length > 0
                  ? l.channelNumbers
                      .map((n, i) => (l.channelNames[i] ? `${n} ${l.channelNames[i]}` : String(n)))
                      .join(", ")
                  : t("common.none"),
                t(`radioHandout.statuses.${keyOf(l.status)}`),
                "",
                "",
              ]),
            empty: t("radioHandout.empty"),
          },
          { kind: "paragraph", text: t("radioHandout.footer") },
        ],
      }),
    },
  ],
};
