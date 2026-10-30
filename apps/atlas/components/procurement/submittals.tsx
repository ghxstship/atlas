import { nextStates } from "@xos/data/commercial-common";
import {
  listPurchaseOrders,
  listSubmittals,
  SUBMITTAL_KINDS,
  type ReviewState,
  type Submittal,
} from "@xos/data/procurement";
import { listTransitionRules, listVendors } from "@xos/data/vendors";
import { getFormatter } from "next-intl/server";
import {
  createSubmittalAction,
  transitionSubmittalAction,
  updateSubmittalAction,
} from "@/app/[org]/procurement/actions";
import { CollabPanels } from "@/components/collection-kit/collab";
import { CollectionView } from "@/components/collection-kit/collection-view";
import { emptyFor } from "@/components/collection-kit/empty";
import { StateHistory } from "@/components/collection-kit/history";
import {
  EntityForm,
  ErrorPanel,
  FormDrawer,
  KitLink,
  KitSection,
  PeekDrawer,
  RecordPage,
  TransitionButtons,
  type FieldSpec,
} from "@/components/collection-kit/kit";
import type { KitRow, KitState, ViewKind } from "@/components/collection-kit/types";
import { PageHeader } from "@/components/collection-kit/ui";
import { getCopy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import * as enums from "@xos/data/enums";
import { CollectionPage } from "@/components/platform/collection-page";

const VIEWS: readonly ViewKind[] = ["table", "list", "board", "calendar"];
const REFUSALS = "procurement.refusals";
const STATES: readonly ReviewState[] = enums.reviewState;
const RECORD_STATE: Record<ReviewState, KitState["state"]> = {
  Proposed: "proposed",
  Submitted: "in-review",
  Returned: "blocked",
  Approved: "complete",
  Canceled: "canceled",
};

/**
 * Submittals of a project (the source of Gateway's vendor submittals tab): shop drawings, product
 * data, samples and certificates a vendor submits for review, optionally against a purchase order.
 * Reviewed by someone other than the person who created it; a return asks for a revision.
 */
export async function SubmittalsSection({
  ctx,
  path,
  search,
  projectId,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
  projectId: string;
}) {
  const state = collectionState(search, VIEWS, await orgToday(ctx));
  const db = ctx.viewer.db;
  const [t, format, all, vendors, orders, rules] = await Promise.all([
    getCopy("procurement"),
    getFormatter(),
    listSubmittals(db, ctx.org.id),
    listVendors(db, ctx.org.id),
    listPurchaseOrders(db, ctx.org.id),
    listTransitionRules<ReviewState>(db, "submittal"),
  ]);
  const title = t("submittals.title");
  if (!all.ok || !vendors.ok || !orders.ok || !rules.ok) {
    return (
      <CollectionPage header={<PageHeader title={title} />}>
        <ErrorPanel what={t("submittals.what")} />
      </CollectionPage>
    );
  }
  const items = all.data.filter((s) => s.projectId === projectId);
  const projectOrders = orders.data.filter((o) => o.projectId === projectId);
  const canWrite = ctx.capabilities.has("procurement.po.write");
  const stateOf = (s: Submittal): KitState => ({
    state: RECORD_STATE[s.state],
    label: t(`reviewStates.${s.state}`),
  });
  const date = (d: string) => format.dateTime(new Date(`${d}T00:00:00`), { dateStyle: "medium" });
  const orderKey = new Map(projectOrders.map((o) => [o.id, o.key]));
  const fields = (s?: Submittal): FieldSpec[] => [
    ...(s
      ? []
      : [
          {
            kind: "select" as const,
            name: "vendorId",
            label: t("fields.vendor"),
            blankLabel: t("fields.chooseVendor"),
            defaultValue: "",
            options: vendors.data.map((v) => ({
              value: v.id,
              label: v.name ?? t("fields.unnamedVendor"),
            })),
          },
        ]),
    {
      kind: "select",
      name: "kind",
      label: t("submittals.kind"),
      defaultValue: s?.kind ?? "Shop Drawing",
      options: SUBMITTAL_KINDS.map((k) => ({ value: k, label: t(`submittals.kinds.${k}`) })),
    },
    {
      kind: "text",
      name: "title",
      label: t("submittals.submittalTitle"),
      required: true,
      defaultValue: s?.title ?? "",
    },
    {
      kind: "text",
      name: "specReference",
      label: t("submittals.spec"),
      help: t("submittals.specHelp"),
      defaultValue: s?.specReference ?? "",
    },
    { kind: "date", name: "dueOn", label: t("submittals.dueOn"), defaultValue: s?.dueOn ?? "" },
    {
      kind: "select",
      name: "purchaseOrderId",
      label: t("submittals.order"),
      blankLabel: t("submittals.noOrder"),
      defaultValue: s?.purchaseOrderId ?? "",
      options: projectOrders.map((o) => ({
        value: o.id,
        label: `${o.key} ${o.vendorName ?? ""}`.trim(),
      })),
    },
  ];
  const selected = state.peek ? items.find((s) => s.id === state.peek) : undefined;
  const properties = (s: Submittal) => [
    { label: t("fields.vendor"), value: s.vendorName ?? t("fields.unnamedVendor") },
    { label: t("submittals.kind"), value: t(`submittals.kinds.${s.kind}`) },
    { label: t("submittals.spec"), value: s.specReference ?? t("submittals.noSpec") },
    { label: t("submittals.dueOn"), value: s.dueOn ? date(s.dueOn) : t("submittals.noDue") },
    {
      label: t("submittals.order"),
      value: s.purchaseOrderId
        ? (orderKey.get(s.purchaseOrderId) ?? t("fields.hiddenOrder"))
        : t("submittals.noOrder"),
    },
    { label: t("submittals.revision"), value: String(s.revision) },
  ];
  const moves = (s: Submittal) =>
    canWrite ? (
      <TransitionButtons
        action={transitionSubmittalAction}
        org={ctx.org.slug}
        id={s.id}
        expected={s.state}
        refusals={REFUSALS}
        moves={nextStates(rules.data, s.state).map((next) => ({
          next,
          label: t(`reviewMoves.${next}`),
          danger: next === "Canceled",
        }))}
      />
    ) : null;

  if (selected && state.full) {
    return (
      <RecordPage
        backHref={withQuery(path, state)}
        backLabel={t("submittals.back")}
        recordKey={selected.key}
        title={selected.title}
        state={stateOf(selected)}
        properties={properties(selected)}
        actions={moves(selected)}
      >
        {canWrite && (selected.state === "Proposed" || selected.state === "Returned") ? (
          <KitSection id="submittal-edit" title={t("submittals.details")}>
            <EntityForm
              id={`submittal-edit-${selected.id}`}
              action={updateSubmittalAction}
              hidden={{ org: ctx.org.slug, id: selected.id }}
              refusals={REFUSALS}
              submitLabel={t("submittals.save")}
              fields={fields(selected)}
            />
          </KitSection>
        ) : null}
        <StateHistory
          ctx={ctx}
          ledger="submittal"
          id={selected.id}
          stateLabel={(x) => t(`reviewStates.${x}`)}
        />
        <CollabPanels ctx={ctx} table="app.submittals" id={selected.id} />
      </RecordPage>
    );
  }

  const rows: KitRow[] = items.map((s) => ({
    id: s.id,
    key: s.key,
    title: s.title,
    state: stateOf(s),
    boardValue: s.state,
    ...(s.dueOn ? { date: s.dueOn } : {}),
    meta: s.vendorName ?? "",
    cells: {
      key: s.key,
      title: s.title,
      vendor: s.vendorName,
      kind: t(`submittals.kinds.${s.kind}`),
      due: s.dueOn ? date(s.dueOn) : null,
      revision: s.revision,
      state: stateOf(s),
    },
  }));

  let drawer = null;
  if (state.create && canWrite) {
    drawer = (
      <FormDrawer title={t("submittals.create")} closeHref={withQuery(path, state)}>
        <EntityForm
          id="submittal-create"
          action={createSubmittalAction}
          hidden={{ org: ctx.org.slug, projectId }}
          refusals={REFUSALS}
          submitLabel={t("submittals.create")}
          successHref={withQuery(path, state, { peek: "{id}" })}
          fields={fields()}
        />
      </FormDrawer>
    );
  } else if (selected) {
    drawer = (
      <PeekDrawer
        recordKey={selected.key}
        title={selected.title}
        state={stateOf(selected)}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id, full: "1" })}
        properties={properties(selected)}
        actions={moves(selected)}
      />
    );
  }

  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      month={state.month}
      columns={[
        { key: "key", label: t("fields.key"), type: "code" },
        { key: "title", label: t("submittals.submittalTitle"), wrap: true },
        { key: "vendor", label: t("fields.vendor") },
        { key: "kind", label: t("submittals.kind") },
        { key: "due", label: t("submittals.dueOn") },
        { key: "revision", label: t("submittals.revision"), type: "number" },
        { key: "state", label: t("fields.state"), type: "state" },
      ]}
      rows={rows}
      board={STATES.map((s) => ({
        value: s,
        state: RECORD_STATE[s],
        label: t(`reviewStates.${s}`),
      }))}
      actions={
        canWrite ? (
          <KitLink href={withQuery(path, state, { create: "1" })} variant="primary">
            {t("submittals.create")}
          </KitLink>
        ) : null
      }
      empty={emptyFor(t, canWrite, withQuery(path, state, { create: "1" }), "submittals")}
    >
      {drawer}
    </CollectionView>
  );
}
