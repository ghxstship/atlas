import { listPrequalifications, listVendors, type Prequalification } from "@xos/data/vendors";
import { getFormatter } from "next-intl/server";
import {
  decidePrequalificationAction,
  requestPrequalificationAction,
} from "@/app/[org]/vendors/actions";
import { CollabPanels } from "@/components/collection-kit/collab";
import { CollectionView } from "@/components/collection-kit/collection-view";
import { emptyFor } from "@/components/collection-kit/empty";
import {
  ActionButton,
  EntityForm,
  ErrorPanel,
  FormDrawer,
  KitLink,
  PeekDrawer,
  RecordPage,
} from "@/components/collection-kit/kit";
import type { KitRow, KitState, ViewKind } from "@/components/collection-kit/types";
import { PageHeader } from "@/components/collection-kit/ui";
import { getCopy, type Copy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import * as enums from "@xos/data/enums";

const VIEWS: readonly ViewKind[] = ["table", "list", "board"];
const REFUSALS = "vendors.refusals";

function standing(q: Prequalification, t: Copy): KitState {
  if (q.decision === "Approved")
    return { state: "complete", label: t("prequalification.decision.Approved") };
  if (q.decision === "Rejected")
    return { state: "canceled", label: t("prequalification.decision.Rejected") };
  return { state: "in-review", label: t("prequalification.decision.Pending") };
}

/**
 * Vendors > Prequalification: requests to prequalify a vendor for a scope, decided once by someone
 * holding vendors.prequalification.approve who did not request it (sod_approval_requester).
 */
export async function VendorPrequalification({
  ctx,
  path,
  search,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
}) {
  const state = collectionState(search, VIEWS, await orgToday(ctx));
  const db = ctx.viewer.db;
  const [t, format, items, vendors] = await Promise.all([
    getCopy("vendors"),
    getFormatter(),
    listPrequalifications(db, ctx.org.id),
    listVendors(db, ctx.org.id),
  ]);
  const title = t("prequalification.title");
  if (!items.ok || !vendors.ok) {
    return (
      <>
        <PageHeader title={title} />
        <ErrorPanel what={t("prequalification.what")} />
      </>
    );
  }
  const canRequest = ctx.capabilities.has("vendors.vendor.write");
  const canDecide = ctx.capabilities.has("vendors.prequalification.approve");
  const date = (d: string) =>
    format.dateTime(new Date(d.length === 10 ? `${d}T00:00:00` : d), { dateStyle: "medium" });
  const selected = state.peek ? items.data.find((q) => q.id === state.peek) : undefined;
  const properties = (q: Prequalification) => [
    { label: t("fields.vendor"), value: q.vendorName ?? t("directory.unnamed") },
    { label: t("prequalification.requested"), value: date(q.createdAt) },
    {
      label: t("prequalification.decided"),
      value: q.decidedAt ? date(q.decidedAt) : t("prequalification.notDecided"),
    },
    {
      label: t("prequalification.validTo"),
      value: q.validTo ? date(q.validTo) : t("prequalification.noExpiry"),
    },
  ];
  const decide = (q: Prequalification) =>
    canDecide && q.decision === null ? (
      <div className="flex flex-wrap gap-8">
        {enums.approvalDecision.map((decision) => (
          <ActionButton
            key={decision}
            action={decidePrequalificationAction}
            hidden={{ org: ctx.org.slug, id: q.id, decision }}
            label={t(`prequalification.${decision === "Approved" ? "approve" : "reject"}`)}
            variant={decision === "Approved" ? "primary" : "danger"}
            confirm={{
              title: t("prequalification.decideTitle"),
              body: t("prequalification.decideBody"),
            }}
            extraFields={
              decision === "Approved"
                ? [{ kind: "date", name: "validTo", label: t("prequalification.validTo") }]
                : []
            }
            refusals={REFUSALS}
          />
        ))}
      </div>
    ) : null;
  const content = (q: Prequalification) => (
    <p className="m-0 whitespace-pre-wrap text-text-14">{q.scopeNote}</p>
  );

  if (selected && state.full) {
    return (
      <RecordPage
        backHref={withQuery(path, state)}
        backLabel={t("prequalification.back")}
        recordKey={selected.vendorName ?? t("directory.unnamed")}
        title={t("prequalification.recordTitle")}
        state={standing(selected, t)}
        properties={properties(selected)}
        actions={decide(selected)}
      >
        {content(selected)}
        <CollabPanels ctx={ctx} table="app.prequalifications" id={selected.id} />
      </RecordPage>
    );
  }

  const rows: KitRow[] = items.data.map((q) => ({
    id: q.id,
    key: q.vendorName ?? t("directory.unnamed"),
    title: q.scopeNote,
    state: standing(q, t),
    boardValue: q.decision ?? "Pending",
    meta: q.validTo
      ? t("prequalification.validUntil", { date: date(q.validTo) })
      : date(q.createdAt),
    cells: {
      vendor: q.vendorName,
      scope: q.scopeNote,
      decision: standing(q, t),
      requested: date(q.createdAt),
      validTo: q.validTo ? date(q.validTo) : null,
    },
  }));

  let drawer = null;
  if (state.create && canRequest) {
    const preset = typeof search["vendor"] === "string" ? search["vendor"] : "";
    drawer = (
      <FormDrawer title={t("prequalification.create")} closeHref={withQuery(path, state)}>
        <EntityForm
          id="prequal-create"
          action={requestPrequalificationAction}
          hidden={{ org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("prequalification.create")}
          successHref={withQuery(path, state, { peek: "{id}" })}
          fields={[
            {
              kind: "select",
              name: "vendorId",
              label: t("fields.vendor"),
              blankLabel: t("fields.chooseVendor"),
              defaultValue: preset,
              options: vendors.data.map((v) => ({
                value: v.id,
                label: v.name ?? t("directory.unnamed"),
              })),
            },
            {
              kind: "textarea",
              name: "scopeNote",
              label: t("prequalification.scope"),
              required: true,
              help: t("prequalification.scopeHelp"),
            },
          ]}
        />
      </FormDrawer>
    );
  } else if (selected) {
    drawer = (
      <PeekDrawer
        recordKey={selected.vendorName ?? t("directory.unnamed")}
        title={t("prequalification.recordTitle")}
        state={standing(selected, t)}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id, full: "1" })}
        properties={properties(selected)}
        actions={decide(selected)}
      >
        {content(selected)}
      </PeekDrawer>
    );
  }

  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "vendor", label: t("fields.vendor") },
        { key: "scope", label: t("prequalification.scope"), wrap: true },
        { key: "decision", label: t("prequalification.decisionLabel"), type: "state" },
        { key: "requested", label: t("prequalification.requested") },
        { key: "validTo", label: t("prequalification.validTo") },
      ]}
      rows={rows}
      board={[
        { value: "Pending", state: "in-review", label: t("prequalification.decision.Pending") },
        { value: "Approved", state: "complete", label: t("prequalification.decision.Approved") },
        { value: "Rejected", state: "canceled", label: t("prequalification.decision.Rejected") },
      ]}
      actions={
        canRequest ? (
          <KitLink href={withQuery(path, state, { create: "1" })} variant="primary">
            {t("prequalification.create")}
          </KitLink>
        ) : null
      }
      empty={emptyFor(t, canRequest, withQuery(path, state, { create: "1" }), "prequalification")}
    >
      {drawer}
    </CollectionView>
  );
}
