import { listAssetClasses } from "@xos/data/assets";
import { listProjectOptions, listPurchaseOrders, listPoLines } from "@xos/data/procurement";
import {
  getNeedLinks,
  listAllocationsReadyToConsolidate,
  listAssetShortages,
  listProcurementNeeds,
  NEED_STATUSES,
  type AssetShortage,
  type NeedStatus,
  type ProcurementNeed,
  type ReadyAllocation,
} from "@xos/data/procurement-needs";
import type { RecordState } from "@xos/ui";
import { getFormatter } from "next-intl/server";
import { randomUUID } from "node:crypto";
import {
  createNeedAction,
  deleteNeedAction,
  requestSubHireAction,
  unlinkOrderLineAction,
  unlinkRequestAction,
  updateNeedAction,
} from "@/app/[org]/procurement/needs-actions";
import { CollectionView } from "@/components/collection-kit/collection-view";
import {
  ActionButton,
  EntityForm,
  ErrorPanel,
  FormDrawer,
  KitLink,
  KitSection,
  PeekDrawer,
  type FieldSpec,
} from "@/components/collection-kit/kit";
import type { KitRow, ViewKind } from "@/components/collection-kit/types";
import { PageHeader } from "@/components/collection-kit/ui";
import { CollectionPage } from "@/components/platform/collection-page";
import { DataTable } from "@/components/platform/client/data-table";
import { EmptyStateLink } from "@/components/ui";
import { getCopy, type Copy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import { ConsolidateForm, LinkOrderLinesForm } from "./needs-forms";
import { SuggestCategoryButton } from "./needs-suggest-button";
import { MaterialQuickAddButton } from "@/components/quick-add/material-quick-add-button";

const VIEWS: readonly ViewKind[] = ["table", "list", "board"];
const REFUSALS = "procurement.refusals";

const STATUS_TONE: Record<NeedStatus, RecordState> = {
  "Needs Ordered": "proposed",
  Short: "blocked",
  "On Order": "active",
  Excess: "in-review",
};

const STATUS_KEY: Record<NeedStatus, string> = {
  "Needs Ordered": "needsOrdered",
  Short: "short",
  "On Order": "onOrder",
  Excess: "excess",
};

/**
 * Procurement > Needs (B11, G-180, G-97): what each event will get, with status computed from order lines, the requests
 * ready to consolidate, and what is short against own stock with a one-click sub-hire draft. Add needs is the page's one
 * primary action (gate 27): Consolidate, Request sub-hire, Paste list, Import and the empty state's action are secondary.
 */
export async function NeedsSection({
  ctx,
  path,
  search,
  projectId,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
  projectId?: string;
}) {
  const state = collectionState(search, VIEWS, await orgToday(ctx));
  const db = ctx.viewer.db;
  const canRead = ctx.capabilities.has("procurement.po.read");
  const canWrite = ctx.capabilities.has("procurement.po.write");
  const canConsolidate = canWrite && ctx.capabilities.has("advancing.packet.read");
  const canDraft = canWrite && ctx.capabilities.has("procurement.rfq.write");
  const [t, format, needs, projects, classes, shortages, ready] = await Promise.all([
    getCopy("procurement"),
    getFormatter(),
    listProcurementNeeds(db, ctx.org.id, projectId),
    listProjectOptions(db, ctx.org.id),
    listAssetClasses(db, ctx.org.id),
    listAssetShortages(db, ctx.org.id, projectId),
    canConsolidate
      ? listAllocationsReadyToConsolidate(db, ctx.org.id, projectId)
      : Promise.resolve({ ok: true as const, data: [] as ReadyAllocation[] }),
  ]);
  const title = t("needs.title");
  if (!needs.ok || !projects.ok) {
    return (
      <CollectionPage header={<PageHeader title={title} />}>
        <ErrorPanel what={t("needs.what")} />
      </CollectionPage>
    );
  }
  const statusLabel = (s: NeedStatus) => t(`needs.statuses.${STATUS_KEY[s]}`);
  const quantityOf = (n: number, unit: string | null) =>
    unit ? `${format.number(n)} ${unit}` : format.number(n);
  const spanOf = (from: string | null, to: string | null) =>
    from && to
      ? format.dateTimeRange(new Date(from), new Date(to), { dateStyle: "medium" })
      : t("needs.noWindow");
  const selected = state.peek ? needs.data.find((n) => n.id === state.peek) : undefined;

  const rows: KitRow[] = needs.data.map((n) => ({
    id: n.id,
    key: n.key,
    title: n.description,
    state: { state: STATUS_TONE[n.status], label: statusLabel(n.status) },
    boardValue: n.status,
    meta: t("needs.line", {
      ordered: format.number(n.orderedQuantity),
      quantity: format.number(n.quantity),
    }),
    cells: {
      key: n.key,
      description: n.description,
      state: { state: STATUS_TONE[n.status], label: statusLabel(n.status) },
      quantity: quantityOf(n.quantity, n.unitBasis),
      requested: format.number(n.requestedQuantity),
      drafted: format.number(n.draftedQuantity),
      ordered: format.number(n.orderedQuantity),
      received: format.number(n.receivedQuantity),
      during: spanOf(n.neededFrom, n.neededTo),
    },
  }));

  const classOptions = (classes.ok ? classes.data : []).map((c) => ({ value: c.id, label: c.name }));
  const projectOptions = projects.data.map((p) => ({ value: p.id, label: `${p.key} ${p.name}` }));
  const formFields = (n?: ProcurementNeed): FieldSpec[] => [
    {
      kind: "text",
      name: "description",
      label: t("needs.description"),
      required: true,
      defaultValue: n?.description ?? "",
    },
    {
      kind: "number",
      name: "quantity",
      label: t("needs.quantity"),
      required: true,
      defaultValue: n ? String(n.quantity) : "",
    },
    { kind: "text", name: "unitBasis", label: t("needs.unit"), defaultValue: n?.unitBasis ?? "" },
    {
      kind: "select",
      name: "assetClassId",
      label: t("needs.assetClass"),
      blankLabel: t("needs.noClass"),
      defaultValue: n?.assetClassId ?? "",
      options: classOptions,
    },
    {
      kind: "datetime",
      name: "neededFrom",
      label: t("needs.neededFrom"),
      defaultValue: n?.neededFrom ? n.neededFrom.slice(0, 16) : "",
    },
    {
      kind: "datetime",
      name: "neededTo",
      label: t("needs.neededTo"),
      defaultValue: n?.neededTo ? n.neededTo.slice(0, 16) : "",
    },
    {
      kind: "textarea",
      name: "note",
      label: t("needs.note"),
      rows: 2,
      defaultValue: n?.note ?? "",
    },
  ];

  let drawer = null;
  if (state.create && canWrite) {
    // The project comes from the page on a project tab; across events it is the first thing to choose.
    const createFields: FieldSpec[] = projectId
      ? formFields()
      : [
          {
            kind: "select",
            name: "projectId",
            label: t("fields.project"),
            blankLabel: t("fields.chooseProject"),
            required: true,
            options: projectOptions,
          },
          ...formFields().filter((f) => f.name !== "note"),
        ];
    drawer = (
      <FormDrawer title={t("needs.create")} closeHref={withQuery(path, state)}>
        <EntityForm
          id="need-create"
          action={createNeedAction}
          hidden={{ org: ctx.org.slug, ...(projectId ? { projectId } : {}) }}
          refusals={REFUSALS}
          submitLabel={t("needs.create")}
          successHref={withQuery(path, state, { peek: "{id}" })}
          fields={createFields}
        />
      </FormDrawer>
    );
  } else if (selected && canRead) {
    drawer = (
      <NeedPeek
        ctx={ctx}
        t={t}
        need={selected}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id })}
        canWrite={canWrite}
        statusLabel={statusLabel(selected.status)}
        statusTone={STATUS_TONE[selected.status]}
        properties={[
          { label: t("fields.project"), value: selected.projectKey },
          { label: t("needs.quantity"), value: quantityOf(selected.quantity, selected.unitBasis) },
          { label: t("needs.requested"), value: format.number(selected.requestedQuantity) },
          { label: t("needs.drafted"), value: format.number(selected.draftedQuantity) },
          { label: t("needs.ordered"), value: format.number(selected.orderedQuantity) },
          { label: t("needs.received"), value: format.number(selected.receivedQuantity) },
          { label: t("needs.during"), value: spanOf(selected.neededFrom, selected.neededTo) },
        ]}
        fields={formFields(selected)}
      />
    );
  }

  const importHref = `/${ctx.org.slug}/import?target=procurement_needs${projectId ? `&project=${projectId}` : ""}`;

  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "key", label: t("fields.key"), type: "code" },
        { key: "description", label: t("needs.description"), wrap: true },
        { key: "state", label: t("needs.status"), type: "state" },
        { key: "quantity", label: t("needs.quantity"), type: "number" },
        { key: "requested", label: t("needs.requested"), type: "number" },
        { key: "drafted", label: t("needs.drafted"), type: "number" },
        { key: "ordered", label: t("needs.ordered"), type: "number" },
        { key: "received", label: t("needs.received"), type: "number" },
        { key: "during", label: t("needs.during") },
      ]}
      rows={rows}
      board={NEED_STATUSES.map((s) => ({
        value: s,
        state: STATUS_TONE[s],
        label: statusLabel(s),
      }))}
      actions={
        canWrite ? (
          <>
            {projectId ? (
              <MaterialQuickAddButton
                org={ctx.org.slug}
                target={{ kind: "needs", projectId }}
              />
            ) : null}
            <KitLink href={importHref}>{t("needs.import")}</KitLink>
            <KitLink href={withQuery(path, state, { create: "1" })} variant="primary">
              {t("needs.create")}
            </KitLink>
          </>
        ) : null
      }
      empty={
        canWrite ? (
          <EmptyStateLink
            icon="Inbox"
            sentence={t("needs.empty")}
            actionLabel={t("needs.create")}
            href={withQuery(path, state, { create: "1" })}
            secondary
          />
        ) : (
          <p className="m-0 text-text-13 text-text-secondary">{t("needs.emptyRead")}</p>
        )
      }
    >
      {drawer}
      {canConsolidate && ready.ok ? (
        <KitSection id="needs-ready" title={t("needs.readyTitle")}>
          <ReadyPart t={t} org={ctx.org.slug} ready={ready.data} needs={needs.data} format={format} />
        </KitSection>
      ) : null}
      <KitSection id="needs-short" title={t("needs.shortTitle")}>
        {shortages.ok ? (
          <ShortPart
            t={t}
            org={ctx.org.slug}
            shortages={shortages.data}
            canDraft={canDraft}
            spanOf={spanOf}
            quantityOf={quantityOf}
          />
        ) : (
          <ErrorPanel what={t("needs.shortTitle")} />
        )}
      </KitSection>
    </CollectionView>
  );
}

function ReadyPart({
  t,
  org,
  ready,
  needs,
  format,
}: {
  t: Copy;
  org: string;
  ready: readonly ReadyAllocation[];
  needs: readonly ProcurementNeed[];
  format: Awaited<ReturnType<typeof getFormatter>>;
}) {
  if (ready.length === 0) {
    return <p className="m-0 text-text-13 text-text-secondary">{t("needs.readyEmpty")}</p>;
  }
  return (
    <ConsolidateForm
      org={org}
      requests={ready.map((r) => ({
        value: r.id,
        label: t("needs.readyLine", {
          quantity: format.number(r.quantity),
          className: r.className,
          holder: r.holderName ?? r.partyName ?? t("fields.someone"),
        }),
      }))}
      needs={needs.map((n) => ({ value: n.id, label: `${n.key} ${n.description}` }))}
    />
  );
}

function ShortPart({
  t,
  org,
  shortages,
  canDraft,
  spanOf,
  quantityOf,
}: {
  t: Copy;
  org: string;
  shortages: readonly AssetShortage[];
  canDraft: boolean;
  spanOf: (from: string | null, to: string | null) => string;
  quantityOf: (n: number, unit: string | null) => string;
}) {
  if (shortages.length === 0) {
    return <p className="m-0 text-text-13 text-text-secondary">{t("needs.shortEmpty")}</p>;
  }
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
      {shortages.map((s) => (
        <li
          key={`${s.projectId}-${s.assetClassId}`}
          className="flex flex-wrap items-center justify-between gap-8 py-8 text-text-13"
        >
          <span>
            {t("needs.shortLine", {
              project: s.projectKey,
              className: s.className,
              quantity: quantityOf(s.shortQuantity, s.unitBasis),
              during: spanOf(s.windowFrom, s.windowTo),
            })}
          </span>
          {s.openRfqId ? (
            <KitLink href={`/${org}/procurement/rfqs?peek=${s.openRfqId}&full=1`} size="sm">
              {t("needs.openRfq")}
            </KitLink>
          ) : canDraft ? (
            <ActionButton
              action={requestSubHireAction}
              hidden={{
                org,
                eventId: randomUUID(),
                projectId: s.projectId,
                assetClassId: s.assetClassId,
                title: t("needs.subHireTitle", { className: s.className }),
              }}
              label={t("needs.requestSubHire")}
              refusals={REFUSALS}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}

async function NeedPeek({
  ctx,
  t,
  need,
  closeHref,
  fullHref,
  canWrite,
  statusLabel,
  statusTone,
  properties,
  fields,
}: {
  ctx: OrgContext;
  t: Copy;
  need: ProcurementNeed;
  closeHref: string;
  fullHref: string;
  canWrite: boolean;
  statusLabel: string;
  statusTone: RecordState;
  properties: { label: string; value: string }[];
  fields: FieldSpec[];
}) {
  const db = ctx.viewer.db;
  const [links, orders] = await Promise.all([
    getNeedLinks(db, need.id),
    canWrite ? listPurchaseOrders(db, ctx.org.id) : Promise.resolve(null),
  ]);
  const projectOrders =
    orders && orders.ok
      ? orders.data.filter((o) => o.projectId === need.projectId && o.state !== "Canceled")
      : [];
  const lineResults = await Promise.all(
    projectOrders.slice(0, 40).map(async (o) => {
      const lines = await listPoLines(db, o.id);
      return lines.ok ? lines.data.map((l) => ({ line: l, orderKey: o.key })) : [];
    }),
  );
  const linked = new Set(links.ok ? links.data.orderLines.map((l) => l.id) : []);
  const lineOptions = lineResults
    .flat()
    .filter((x) => !linked.has(x.line.id))
    .map((x) => ({
      value: x.line.id,
      label: `${x.orderKey} ${x.line.lineNumber}: ${x.line.description}`,
    }));
  return (
    <PeekDrawer
      recordKey={need.key}
      title={need.description}
      state={{ state: statusTone, label: statusLabel }}
      closeHref={closeHref}
      fullHref={fullHref}
      properties={properties}
      actions={
        canWrite ? (
          <ActionButton
            action={deleteNeedAction}
            hidden={{ org: ctx.org.slug, id: need.id }}
            label={t("needs.delete")}
            confirm={{ title: t("needs.deleteTitle"), body: t("needs.deleteBody") }}
            refusals={REFUSALS}
          />
        ) : null
      }
    >
      {!links.ok ? (
        <ErrorPanel what={t("needs.what")} />
      ) : (
        <>
          {canWrite && !need.assetClassId && !need.elementId ? (
            <SuggestCategoryButton org={ctx.org.slug} needId={need.id} description={need.description} />
          ) : null}
          <KitSection id="need-requests" title={t("needs.linkedRequests")}>
            {links.data.requests.length === 0 ? (
              <p className="m-0 text-text-13 text-text-secondary">{t("needs.noRequests")}</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-8 p-0 text-text-13">
                {links.data.requests.map((r, i) => (
                  <li key={r.allocationId} className="flex items-center justify-between gap-8">
                    {t("needs.requestNumber", { n: i + 1 })}
                    {canWrite ? (
                      <ActionButton
                        action={unlinkRequestAction}
                        hidden={{ org: ctx.org.slug, allocationId: r.allocationId }}
                        label={t("needs.unlink")}
                        refusals={REFUSALS}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </KitSection>
          <KitSection id="need-lines" title={t("needs.orderLines")}>
            {links.data.orderLines.length === 0 ? (
              <p className="m-0 text-text-13 text-text-secondary">{t("needs.noLines")}</p>
            ) : (
              <DataTable
                caption={t("needs.orderLines")}
                columns={[
                  { key: "line", label: t("needs.description") },
                  { key: "quantity", label: t("needs.quantity"), type: "number" },
                  { key: "state", label: t("fields.state") },
                ]}
                rows={links.data.orderLines.map((l) => ({
                  line: l.description,
                  quantity: l.quantity,
                  state: t(`poStates.${l.orderState}`),
                }))}
              />
            )}
            {canWrite && links.data.orderLines.length > 0 ? (
              <div className="flex flex-wrap gap-8">
                {links.data.orderLines.map((l) => (
                  <ActionButton
                    key={l.id}
                    action={unlinkOrderLineAction}
                    hidden={{ org: ctx.org.slug, poLineId: l.id }}
                    label={t("needs.unlinkLine", { n: l.lineNumber })}
                    refusals={REFUSALS}
                  />
                ))}
              </div>
            ) : null}
            {canWrite && lineOptions.length > 0 ? (
              <LinkOrderLinesForm org={ctx.org.slug} needId={need.id} lines={lineOptions} />
            ) : null}
          </KitSection>
          <KitSection id="need-rfqs" title={t("needs.rfqs")}>
            {links.data.rfqLines.length === 0 ? (
              <p className="m-0 text-text-13 text-text-secondary">{t("needs.noRfqs")}</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-8 p-0 text-text-13">
                {links.data.rfqLines.map((l) => (
                  <li key={l.id}>
                    <KitLink href={`/${ctx.org.slug}/procurement/rfqs?peek=${l.rfqId}&full=1`} size="sm">
                      {`${l.title}: ${t(`rfqStates.${l.state}`)}`}
                    </KitLink>
                  </li>
                ))}
              </ul>
            )}
          </KitSection>
          {canWrite ? (
            <KitSection id="need-edit" title={t("needs.edit")}>
              <EntityForm
                id={`need-edit-${need.id}`}
                action={updateNeedAction}
                hidden={{ org: ctx.org.slug, id: need.id }}
                refusals={REFUSALS}
                submitLabel={t("needs.save")}
                fields={fields}
              />
            </KitSection>
          ) : null}
        </>
      )}
    </PeekDrawer>
  );
}
