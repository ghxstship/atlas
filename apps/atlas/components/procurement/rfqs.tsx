import { nextStates } from "@xos/data/commercial-common";
import {
  listCurrencies,
  listProjectOptions,
  listRfqResponses,
  listRfqs,
  type Rfq,
  type RfqState,
} from "@xos/data/procurement";
import { listTransitionRules, listVendors } from "@xos/data/vendors";
import { getFormatter } from "next-intl/server";
import {
  createRfqAction,
  inviteVendorAction,
  orderFromResponseAction,
  recordResponseAction,
  removeInvitationAction,
  transitionRfqAction,
  updateRfqAction,
} from "@/app/[org]/procurement/actions";
import { CollabPanels } from "@/components/collection-kit/collab";
import { CollectionView } from "@/components/collection-kit/collection-view";
import { emptyFor } from "@/components/collection-kit/empty";
import { StateHistory } from "@/components/collection-kit/history";
import {
  ActionButton,
  EntityForm,
  ErrorPanel,
  FormDrawer,
  KitLink,
  KitSection,
  PeekDrawer,
  RecordPage,
  TransitionButtons,
} from "@/components/collection-kit/kit";
import { recordStateOf, type KitRow, type ViewKind } from "@/components/collection-kit/types";
import { InlineAlert, PageHeader } from "@/components/collection-kit/ui";
import { DataTable } from "@/components/platform/client/data-table";
import { getCopy, type Copy } from "@/lib/collection-kit/i18n";
import {
  collectionState,
  formatMinor,
  withQuery,
  type SearchParams,
} from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { ResponseForm } from "./forms";

const VIEWS: readonly ViewKind[] = ["table", "list", "board"];
const REFUSALS = "procurement.refusals";
const STATES: readonly RfqState[] = ["Proposed", "Issued", "Closed", "Awarded", "Canceled"];

/** Which capability each RFQ move needs (app.transition_rfq). */
const MOVE_CAPABILITY: Record<RfqState, string> = {
  Proposed: "procurement.rfq.write",
  Issued: "procurement.rfq.issue",
  Closed: "procurement.bid.unseal",
  Awarded: "procurement.bid.award",
  Canceled: "procurement.rfq.write",
};

/**
 * Procurement > RFQs (journey 4): draft an RFQ on a project, invite vendors, issue it, keep
 * responses sealed until it closes, compare the quotes, award, and issue the purchase order from
 * the awarded response. Vendors respond in Gateway; a quote received another way is recorded here.
 */
export async function RfqsSection({
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
  const state = collectionState(search, VIEWS);
  const db = ctx.viewer.db;
  const [t, format, all, projects, vendors, rules] = await Promise.all([
    getCopy("procurement"),
    getFormatter(),
    listRfqs(db, ctx.org.id),
    listProjectOptions(db, ctx.org.id),
    listVendors(db, ctx.org.id),
    listTransitionRules<RfqState>(db, "rfq"),
  ]);
  const title = t("rfqs.title");
  if (!all.ok || !projects.ok || !vendors.ok || !rules.ok) {
    return (
      <>
        <PageHeader title={title} />
        <ErrorPanel what={t("rfqs.what")} />
      </>
    );
  }
  const rfqs = projectId ? all.data.filter((r) => r.projectId === projectId) : all.data;
  const canWrite = ctx.capabilities.has("procurement.rfq.write");
  const stateLabel = (s: string) => t(`rfqStates.${s}`);
  const when = (d: string | null) =>
    d
      ? format.dateTime(new Date(d), { dateStyle: "medium", timeStyle: "short" })
      : t("rfqs.noDeadline");
  const vendorName = new Map(vendors.data.map((v) => [v.id, v.name ?? t("fields.unnamedVendor")]));
  const selected = state.peek ? rfqs.find((r) => r.id === state.peek) : undefined;
  const moves = (r: Rfq) =>
    nextStates(rules.data, r.state)
      .filter((next) => ctx.capabilities.has(MOVE_CAPABILITY[next]))
      .map((next) => ({ next, label: t(`rfqMoves.${next}`), danger: next === "Canceled" }));
  const properties = (r: Rfq) => [
    { label: t("fields.project"), value: r.projectKey ?? t("fields.hiddenProject") },
    { label: t("rfqs.deadline"), value: when(r.responsesDueAt) },
    { label: t("rfqs.invited"), value: String(r.invitedVendorIds.length) },
  ];
  const transitions = (r: Rfq) => (
    <TransitionButtons
      action={transitionRfqAction}
      org={ctx.org.slug}
      id={r.id}
      expected={r.state}
      refusals={REFUSALS}
      moves={moves(r)}
    />
  );

  if (selected && state.full) {
    return (
      <RfqRecord
        ctx={ctx}
        rfq={selected}
        t={t}
        backHref={withQuery(path, state)}
        properties={properties(selected)}
        transitions={transitions(selected)}
        vendorName={vendorName}
        vendors={vendors.data.map((v) => ({
          value: v.id,
          label: v.name ?? t("fields.unnamedVendor"),
        }))}
        canWrite={canWrite}
        stateLabel={stateLabel}
        purchaseOrdersPath={`/${ctx.org.slug}/procurement/purchase-orders`}
      />
    );
  }

  const rows: KitRow[] = rfqs.map((r) => ({
    id: r.id,
    key: r.key,
    title: r.title,
    state: { state: recordStateOf(r.state), label: stateLabel(r.state) },
    boardValue: r.state,
    meta: t("rfqs.dueLine", { when: when(r.responsesDueAt) }),
    cells: {
      key: r.key,
      title: r.title,
      state: { state: recordStateOf(r.state), label: stateLabel(r.state) },
      deadline: when(r.responsesDueAt),
      invited: r.invitedVendorIds.length,
    },
  }));

  let drawer = null;
  if (state.create && canWrite) {
    drawer = (
      <FormDrawer title={t("rfqs.create")} closeHref={withQuery(path, state)}>
        <EntityForm
          id="rfq-create"
          action={createRfqAction}
          hidden={{ org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("rfqs.create")}
          successHref={withQuery(path, state, { peek: "{id}" })}
          fields={[
            {
              kind: "select",
              name: "projectId",
              label: t("fields.project"),
              blankLabel: t("fields.chooseProject"),
              defaultValue: projectId ?? "",
              options: projects.data.map((p) => ({ value: p.id, label: `${p.key} ${p.name}` })),
            },
            {
              kind: "text",
              name: "title",
              label: t("rfqs.rfqTitle"),
              required: true,
              help: t("rfqs.titleHelp"),
            },
            { kind: "datetime", name: "responsesDueAt", label: t("rfqs.deadline") },
          ]}
        />
      </FormDrawer>
    );
  } else if (selected) {
    drawer = (
      <PeekDrawer
        recordKey={selected.key}
        title={selected.title}
        state={{ state: recordStateOf(selected.state), label: stateLabel(selected.state) }}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id, full: "1" })}
        properties={properties(selected)}
        actions={transitions(selected)}
      >
        <p className="m-0 text-text-13 text-text-secondary">
          {selected.state === "Issued" ? t("rfqs.sealedNotice") : t("rfqs.openFullHint")}
        </p>
      </PeekDrawer>
    );
  }

  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "key", label: t("fields.key"), type: "code" },
        { key: "title", label: t("rfqs.rfqTitle"), wrap: true },
        { key: "state", label: t("fields.state"), type: "state" },
        { key: "deadline", label: t("rfqs.deadline") },
        { key: "invited", label: t("rfqs.invited"), type: "number" },
      ]}
      rows={rows}
      board={STATES.map((s) => ({ value: s, state: recordStateOf(s), label: stateLabel(s) }))}
      actions={
        canWrite ? (
          <KitLink href={withQuery(path, state, { create: "1" })} variant="primary">
            {t("rfqs.create")}
          </KitLink>
        ) : null
      }
      empty={emptyFor(t, canWrite, withQuery(path, state, { create: "1" }), "rfqs")}
    >
      {drawer}
    </CollectionView>
  );
}

async function RfqRecord({
  ctx,
  rfq,
  t,
  backHref,
  properties,
  transitions,
  vendorName,
  vendors,
  canWrite,
  stateLabel,
  purchaseOrdersPath,
}: {
  ctx: OrgContext;
  rfq: Rfq;
  t: Copy;
  backHref: string;
  properties: { label: string; value: string }[];
  transitions: React.ReactNode;
  vendorName: Map<string, string>;
  vendors: { value: string; label: string }[];
  canWrite: boolean;
  stateLabel: (s: string) => string;
  purchaseOrdersPath: string;
}) {
  const db = ctx.viewer.db;
  const [format, responses, currencies] = await Promise.all([
    getFormatter(),
    listRfqResponses(db, rfq.id),
    listCurrencies(db),
  ]);
  const exponent = new Map(
    (currencies.ok ? currencies.data : []).map((c) => [c.code, c.minorUnits]),
  );
  const invited = rfq.invitedVendorIds;
  const uninvited = vendors.filter((v) => !invited.includes(v.value));
  const open = rfq.state === "Proposed" || rfq.state === "Issued";
  const unsealed = rfq.state === "Closed" || rfq.state === "Awarded";
  return (
    <RecordPage
      backHref={backHref}
      backLabel={t("rfqs.back")}
      recordKey={rfq.key}
      title={rfq.title}
      state={{ state: recordStateOf(rfq.state), label: stateLabel(rfq.state) }}
      properties={properties}
      actions={transitions}
    >
      {canWrite && rfq.state === "Proposed" ? (
        <KitSection id="rfq-details" title={t("rfqs.details")}>
          <EntityForm
            id={`rfq-edit-${rfq.id}`}
            action={updateRfqAction}
            hidden={{ org: ctx.org.slug, id: rfq.id }}
            refusals={REFUSALS}
            submitLabel={t("rfqs.save")}
            fields={[
              {
                kind: "text",
                name: "title",
                label: t("rfqs.rfqTitle"),
                required: true,
                defaultValue: rfq.title,
              },
              {
                kind: "datetime",
                name: "responsesDueAt",
                label: t("rfqs.deadline"),
                defaultValue: rfq.responsesDueAt ? rfq.responsesDueAt.slice(0, 16) : "",
              },
            ]}
          />
        </KitSection>
      ) : null}

      <KitSection id="rfq-invitations" title={t("rfqs.invitations")}>
        {invited.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("rfqs.noInvitations")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {invited.map((id) => (
              <li
                key={id}
                className="flex flex-wrap items-center justify-between gap-8 py-8 text-text-13"
              >
                {vendorName.get(id) ?? t("fields.unnamedVendor")}
                {canWrite && open ? (
                  <ActionButton
                    action={removeInvitationAction}
                    hidden={{ org: ctx.org.slug, rfqId: rfq.id, vendorId: id }}
                    label={t("rfqs.uninvite")}
                    refusals={REFUSALS}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canWrite && open && uninvited.length > 0 ? (
          <EntityForm
            id={`rfq-invite-${rfq.id}`}
            action={inviteVendorAction}
            hidden={{ org: ctx.org.slug, rfqId: rfq.id }}
            refusals={REFUSALS}
            submitLabel={t("rfqs.invite")}
            fields={[
              { kind: "select", name: "vendorId", label: t("fields.vendor"), options: uninvited },
            ]}
          />
        ) : null}
      </KitSection>

      <KitSection id="rfq-responses" title={t("rfqs.responses")}>
        {!responses.ok ? (
          <ErrorPanel what={t("rfqs.responses")} />
        ) : !unsealed ? (
          <InlineAlert tone="info" title={t("rfqs.sealedTitle")}>
            {t("rfqs.sealedNotice")}
          </InlineAlert>
        ) : responses.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("rfqs.noResponses")}</p>
        ) : (
          <>
            <DataTable
              caption={t("rfqs.comparison")}
              columns={[
                { key: "vendor", label: t("fields.vendor") },
                { key: "lines", label: t("rfqs.lineCount"), type: "number" },
                { key: "total", label: t("rfqs.total") },
                { key: "valid", label: t("rfqs.validUntil") },
              ]}
              rows={responses.data.map((r) => {
                const currency = r.lines[0]?.currencyCode ?? null;
                return {
                  vendor: r.vendorName ?? t("fields.unnamedVendor"),
                  lines: r.lines.length,
                  total: formatMinor(
                    format,
                    r.totalMinor,
                    currency,
                    exponent.get(currency ?? "") ?? 2,
                    t("money.unpricedTotal"),
                  ),
                  valid: r.validUntil
                    ? format.dateTime(new Date(`${r.validUntil}T00:00:00`), { dateStyle: "medium" })
                    : t("rfqs.noValidity"),
                };
              })}
            />
            {rfq.state === "Awarded" && ctx.capabilities.has("procurement.po.write") ? (
              <div className="flex flex-wrap gap-8">
                {responses.data.map((r) => (
                  <ActionButton
                    key={r.id}
                    action={orderFromResponseAction}
                    hidden={{ org: ctx.org.slug, rfqId: rfq.id, responseId: r.id }}
                    label={t("rfqs.orderFrom", {
                      vendor: r.vendorName ?? t("fields.unnamedVendor"),
                    })}
                    variant="primary"
                    confirm={{ title: t("rfqs.orderTitle"), body: t("rfqs.orderBody") }}
                    refusals={REFUSALS}
                  />
                ))}
                <KitLink href={purchaseOrdersPath} size="sm">
                  {t("rfqs.viewOrders")}
                </KitLink>
              </div>
            ) : null}
          </>
        )}
        {canWrite && rfq.state === "Issued" && invited.length > 0 ? (
          <KitSection id="rfq-record-response" title={t("rfqs.recordResponse")}>
            <p className="m-0 text-text-13 text-text-secondary">{t("rfqs.recordHelp")}</p>
            <ResponseForm
              org={ctx.org.slug}
              rfqId={rfq.id}
              action={recordResponseAction}
              vendors={invited.map((id) => ({
                value: id,
                label: vendorName.get(id) ?? t("fields.unnamedVendor"),
              }))}
              currencies={(currencies.ok ? currencies.data : []).map((c) => ({
                value: c.code,
                label: c.code,
              }))}
              defaultCurrency="USD"
            />
          </KitSection>
        ) : null}
      </KitSection>

      <StateHistory ctx={ctx} ledger="rfq" id={rfq.id} stateLabel={stateLabel} />
      <CollabPanels ctx={ctx} table="app.rfqs" id={rfq.id} />
    </RecordPage>
  );
}
