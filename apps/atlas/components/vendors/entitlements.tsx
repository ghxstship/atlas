import { nextStates } from "@xos/data/commercial-common";
import { listProjectOptions } from "@xos/data/procurement";
import {
  listCounterparties,
  listEntitlementDeliveries,
  listProofOfPerformance,
  listSponsorAssets,
  sponsorSuppliedMoves,
  listSponsorEntitlements,
  listTransitionRules,
  SPONSOR_ASSET_KINDS,
  type EntitlementDelivery,
  type ProofOfPerformance,
  type ReviewState,
  type SponsorAsset,
  type SponsorEntitlement,
} from "@xos/data/vendors";
import { getFormatter } from "next-intl/server";
import {
  createEntitlementAction,
  createSponsorAssetAction,
  deleteEntitlementAction,
  fulfillEntitlementAction,
  recordDeliveryAction,
  transitionSponsorAssetAction,
  updateEntitlementAction,
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
  KitSection,
  PeekDrawer,
  RecordPage,
  TransitionButtons,
  type FieldSpec,
} from "@/components/collection-kit/kit";
import type { KitRow, KitState, ViewKind } from "@/components/collection-kit/types";
import { PageHeader } from "@/components/collection-kit/ui";
import { getCopy, type Copy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import { CollectionPage } from "@/components/platform/collection-page";

const VIEWS: readonly ViewKind[] = ["table", "list", "board"];
const REFUSALS = "vendors.refusals";

function standing(e: SponsorEntitlement, proof: ProofOfPerformance | undefined, t: Copy): KitState {
  if (proof?.isMet || e.fulfilledAt)
    return { state: "complete", label: t("entitlements.delivered") };
  if (proof && proof.deliveryCount > 0)
    return { state: "active", label: t("entitlements.partial") };
  return { state: "proposed", label: t("entitlements.owed") };
}

/**
 * Vendors > Sponsor entitlements: what each sponsor is owed on a project (gate 8 sponsor
 * obligations), the brand assets each entitlement needs with their approval, every delivery with
 * its photos, and the proof of performance rolled up against what is owed.
 */
export async function SponsorEntitlements({
  ctx,
  path,
  search,
  projectId,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
  /** Set on a project tab: only this project's entitlements. */
  projectId?: string;
}) {
  const state = collectionState(search, VIEWS, await orgToday(ctx));
  const db = ctx.viewer.db;
  const [t, format, all, proofs, assets, deliveries, sponsors, projects, assetRules] =
    await Promise.all([
      getCopy("vendors"),
      getFormatter(),
      listSponsorEntitlements(db, ctx.org.id),
      listProofOfPerformance(db),
      listSponsorAssets(db, ctx.org.id),
      listEntitlementDeliveries(db, ctx.org.id),
      listCounterparties(db, ctx.org.id),
      listProjectOptions(db, ctx.org.id),
      listTransitionRules<ReviewState>(db, "sponsor_asset"),
    ]);
  const title = t("entitlements.title");
  if (
    !all.ok ||
    !proofs.ok ||
    !assets.ok ||
    !deliveries.ok ||
    !sponsors.ok ||
    !projects.ok ||
    !assetRules.ok
  ) {
    return (
      <CollectionPage header={<PageHeader title={title} />}>
        <ErrorPanel what={t("entitlements.what")} />
      </CollectionPage>
    );
  }
  const items = projectId ? all.data.filter((e) => e.projectId === projectId) : all.data;
  const canWrite = ctx.capabilities.has("vendors.entitlement.write");
  const proofOf = new Map(proofs.data.map((p) => [p.entitlementId, p]));
  const date = (d: string) =>
    format.dateTime(new Date(d.length === 10 ? `${d}T00:00:00` : d), { dateStyle: "medium" });
  const sponsorOptions = sponsors.data.map((c) => ({
    value: c.id,
    label: c.name ?? t("directory.unnamed"),
  }));
  const fields = (e?: SponsorEntitlement): FieldSpec[] => [
    ...(e
      ? []
      : [
          {
            kind: "select" as const,
            name: "projectId",
            label: t("fields.project"),
            blankLabel: t("fields.chooseProject"),
            defaultValue: projectId ?? "",
            options: projects.data.map((p) => ({ value: p.id, label: `${p.key} ${p.name}` })),
          },
        ]),
    {
      kind: "select",
      name: "counterpartyId",
      label: t("entitlements.sponsor"),
      blankLabel: t("entitlements.chooseSponsor"),
      defaultValue: e?.counterpartyId ?? "",
      options: sponsorOptions,
    },
    {
      kind: "textarea",
      name: "description",
      label: t("entitlements.description"),
      required: true,
      defaultValue: e?.description ?? "",
    },
    {
      kind: "number",
      name: "quantity",
      label: t("entitlements.quantity"),
      help: t("entitlements.quantityHelp"),
      defaultValue: e?.quantity === null || e?.quantity === undefined ? "" : String(e.quantity),
    },
    { kind: "date", name: "dueOn", label: t("entitlements.dueOn"), defaultValue: e?.dueOn ?? "" },
  ];
  const selected = state.peek ? items.find((e) => e.id === state.peek) : undefined;
  const quantityText = (n: number | null) =>
    n === null ? t("entitlements.notCounted") : String(n);
  const properties = (e: SponsorEntitlement) => {
    const proof = proofOf.get(e.id);
    return [
      { label: t("entitlements.sponsor"), value: e.sponsorName ?? t("directory.unnamed") },
      {
        label: t("fields.project"),
        value: e.projectKey
          ? `${e.projectKey} ${e.projectName ?? ""}`
          : t("scorecards.hiddenProject"),
      },
      { label: t("entitlements.quantity"), value: quantityText(e.quantity) },
      { label: t("entitlements.dueOn"), value: e.dueOn ? date(e.dueOn) : t("entitlements.noDue") },
      {
        label: t("entitlements.deliveredQuantity"),
        value: quantityText(proof?.quantityDelivered ?? null),
      },
      { label: t("entitlements.deliveries"), value: String(proof?.deliveryCount ?? 0) },
      {
        label: t("entitlements.fulfilledAt"),
        value: e.fulfilledAt ? date(e.fulfilledAt) : t("entitlements.notFulfilled"),
      },
    ];
  };
  const controls = (e: SponsorEntitlement) =>
    canWrite ? (
      <>
        <ActionButton
          action={fulfillEntitlementAction}
          hidden={{ org: ctx.org.slug, id: e.id, fulfilled: e.fulfilledAt ? "0" : "1" }}
          label={e.fulfilledAt ? t("entitlements.reopen") : t("entitlements.markFulfilled")}
          variant={e.fulfilledAt ? "secondary" : "primary"}
          refusals={REFUSALS}
        />
        <ActionButton
          action={deleteEntitlementAction}
          hidden={{ org: ctx.org.slug, id: e.id }}
          label={t("entitlements.delete")}
          variant="danger"
          confirm={{ title: t("entitlements.deleteTitle"), body: t("entitlements.deleteBody") }}
          refusals={REFUSALS}
        />
      </>
    ) : null;
  const assetSection = (e: SponsorEntitlement) => {
    const mine = assets.data.filter((a) => a.entitlementId === e.id);
    return (
      <KitSection id={`assets-${e.id}`} title={t("assets.title")}>
        {mine.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("assets.empty")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {mine.map((a: SponsorAsset) => (
              <li key={a.id} className="flex flex-col gap-4 py-8">
                <span className="text-text-13 font-medium">
                  {a.title} · {t(`assets.kinds.${a.kind}`)} · {t(`reviewStates.${a.state}`)}
                  {a.revision > 0 ? ` · ${t("assets.revision", { revision: a.revision })}` : ""}
                  {a.source === "Sponsor Supplied" ? ` · ${t("assets.sponsorSupplied")}` : ""}
                </span>
                {a.files.length > 0 ? (
                  <span className="flex flex-wrap gap-8 text-text-12">
                    {a.files.map((f, i) =>
                      f.versionId ? (
                        <a
                          key={i}
                          href={`/files/party/${f.versionId}`}
                          className="text-accent-text hover:underline"
                        >
                          {f.title}
                        </a>
                      ) : null,
                    )}
                  </span>
                ) : null}
                {canWrite ? (
                  <TransitionButtons
                    action={transitionSponsorAssetAction}
                    org={ctx.org.slug}
                    id={a.id}
                    expected={a.state}
                    refusals={REFUSALS}
                    // R9: the org approves, returns or cancels what the sponsor supplied; resubmitting is the sponsor's.
                    moves={(a.source === "Sponsor Supplied"
                      ? sponsorSuppliedMoves(a.state)
                      : nextStates(assetRules.data, a.state)
                    ).map((next) => ({
                      next,
                      label: t(`reviewMoves.${next}`),
                      danger: next === "Canceled",
                    }))}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canWrite ? (
          <EntityForm
            id={`asset-add-${e.id}`}
            action={createSponsorAssetAction}
            hidden={{ org: ctx.org.slug, entitlementId: e.id }}
            refusals={REFUSALS}
            submitLabel={t("assets.add")}
            fields={[
              {
                kind: "select",
                name: "kind",
                label: t("assets.kind"),
                defaultValue: "Logo",
                options: SPONSOR_ASSET_KINDS.map((k) => ({
                  value: k,
                  label: t(`assets.kinds.${k}`),
                })),
              },
              { kind: "text", name: "title", label: t("assets.assetTitle"), required: true },
              { kind: "text", name: "usageNote", label: t("assets.usage") },
              { kind: "date", name: "dueOn", label: t("assets.dueOn") },
            ]}
          />
        ) : null}
      </KitSection>
    );
  };
  const deliverySection = (e: SponsorEntitlement) => {
    const mine = deliveries.data.filter((d: EntitlementDelivery) => d.entitlementId === e.id);
    return (
      <KitSection id={`deliveries-${e.id}`} title={t("deliveries.title")}>
        {mine.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("deliveries.empty")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
            {mine.map((d) => (
              <li key={d.id}>
                {t("deliveries.line", {
                  date: date(d.deliveredOn),
                  quantity: quantityText(d.quantityDelivered),
                })}
                {d.note ? ` · ${d.note}` : ""}
              </li>
            ))}
          </ul>
        )}
        {canWrite ? (
          <EntityForm
            id={`delivery-add-${e.id}`}
            action={recordDeliveryAction}
            hidden={{ org: ctx.org.slug, entitlementId: e.id }}
            refusals={REFUSALS}
            submitLabel={t("deliveries.add")}
            fields={[
              {
                kind: "date",
                name: "deliveredOn",
                label: t("deliveries.deliveredOn"),
                required: true,
              },
              {
                kind: "number",
                name: "quantityDelivered",
                label: t("deliveries.quantity"),
                help: t("deliveries.quantityHelp"),
              },
              { kind: "textarea", name: "note", label: t("deliveries.note"), rows: 2 },
            ]}
          />
        ) : null}
      </KitSection>
    );
  };

  if (selected && state.full) {
    return (
      <RecordPage
        backHref={withQuery(path, state)}
        backLabel={t("entitlements.back")}
        recordKey={selected.projectKey ?? t("entitlements.entitlement")}
        title={selected.description}
        state={standing(selected, proofOf.get(selected.id), t)}
        properties={properties(selected)}
        actions={controls(selected)}
      >
        {canWrite ? (
          <KitSection id="entitlement-edit" title={t("entitlements.edit")}>
            <EntityForm
              id={`entitlement-edit-${selected.id}`}
              action={updateEntitlementAction}
              hidden={{ org: ctx.org.slug, id: selected.id }}
              refusals={REFUSALS}
              submitLabel={t("entitlements.save")}
              fields={fields(selected)}
            />
          </KitSection>
        ) : null}
        {assetSection(selected)}
        {deliverySection(selected)}
        <CollabPanels ctx={ctx} table="app.sponsor_entitlements" id={selected.id} />
      </RecordPage>
    );
  }

  const rows: KitRow[] = items.map((e) => {
    const s = standing(e, proofOf.get(e.id), t);
    return {
      id: e.id,
      key: e.projectKey ?? t("entitlements.entitlement"),
      title: e.description,
      state: s,
      boardValue: s.state === "complete" ? "delivered" : s.state === "active" ? "partial" : "owed",
      meta: e.sponsorName ?? "",
      cells: {
        sponsor: e.sponsorName,
        description: e.description,
        project: e.projectKey,
        quantity: quantityText(e.quantity),
        delivered: quantityText(proofOf.get(e.id)?.quantityDelivered ?? null),
        due: e.dueOn ? date(e.dueOn) : null,
        standing: s,
      },
    };
  });

  let drawer = null;
  if (state.create && canWrite) {
    drawer = (
      <FormDrawer title={t("entitlements.create")} closeHref={withQuery(path, state)}>
        <EntityForm
          id="entitlement-create"
          action={createEntitlementAction}
          hidden={{ org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("entitlements.create")}
          successHref={withQuery(path, state, { peek: "{id}" })}
          fields={fields()}
        />
      </FormDrawer>
    );
  } else if (selected) {
    drawer = (
      <PeekDrawer
        recordKey={selected.projectKey ?? t("entitlements.entitlement")}
        title={selected.description}
        state={standing(selected, proofOf.get(selected.id), t)}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id, full: "1" })}
        properties={properties(selected)}
        actions={controls(selected)}
      >
        {assetSection(selected)}
        {deliverySection(selected)}
      </PeekDrawer>
    );
  }

  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "sponsor", label: t("entitlements.sponsor") },
        { key: "description", label: t("entitlements.description"), wrap: true },
        { key: "project", label: t("fields.project"), type: "code" },
        { key: "quantity", label: t("entitlements.quantity") },
        { key: "delivered", label: t("entitlements.deliveredQuantity") },
        { key: "due", label: t("entitlements.dueOn") },
        { key: "standing", label: t("entitlements.standing"), type: "state" },
      ]}
      rows={rows}
      board={[
        { value: "owed", state: "proposed", label: t("entitlements.owed") },
        { value: "partial", state: "active", label: t("entitlements.partial") },
        { value: "delivered", state: "complete", label: t("entitlements.delivered") },
      ]}
      actions={
        canWrite ? (
          <KitLink href={withQuery(path, state, { create: "1" })} variant="primary">
            {t("entitlements.create")}
          </KitLink>
        ) : null
      }
      empty={emptyFor(t, canWrite, withQuery(path, state, { create: "1" }), "entitlements")}
    >
      {drawer}
    </CollectionView>
  );
}
