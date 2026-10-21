import { listProjectOptions } from "@xos/data/procurement";
import { listScorecards, listVendors, scorecardAverage, type Scorecard } from "@xos/data/vendors";
import { getFormatter } from "next-intl/server";
import {
  createScorecardAction,
  deleteScorecardAction,
  updateScorecardAction,
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
  type FieldSpec,
} from "@/components/collection-kit/kit";
import type { KitRow, ViewKind } from "@/components/collection-kit/types";
import { PageHeader } from "@/components/collection-kit/ui";
import { getCopy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";

const VIEWS: readonly ViewKind[] = ["table", "list", "chart"];
const REFUSALS = "vendors.refusals";

/**
 * Vendors > Scorecards: quality, delivery and safety scores per vendor and period, optionally for
 * one project. An unscored dimension stays blank and averages leave it out (never zero). The chart
 * view compares vendors' average scores.
 */
export async function VendorScorecards({
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
  const [t, format, cards, vendors, projects] = await Promise.all([
    getCopy("vendors"),
    getFormatter(),
    listScorecards(db, ctx.org.id),
    listVendors(db, ctx.org.id),
    listProjectOptions(db, ctx.org.id),
  ]);
  const title = t("scorecards.title");
  if (!cards.ok || !vendors.ok || !projects.ok) {
    return (
      <>
        <PageHeader title={title} />
        <ErrorPanel what={t("scorecards.what")} />
      </>
    );
  }
  const canWrite = ctx.capabilities.has("vendors.scorecard.write");
  const projectName = new Map(projects.data.map((p) => [p.id, `${p.key} ${p.name}`]));
  const date = (d: string) => format.dateTime(new Date(`${d}T00:00:00`), { dateStyle: "medium" });
  const score = (n: number | null) => (n === null ? t("scorecards.unscored") : String(n));
  const scoreOptions = [1, 2, 3, 4, 5].map((n) => ({
    value: String(n),
    label: t("scorecards.scoreOption", { score: n }),
  }));
  const fields = (c?: Scorecard): FieldSpec[] => [
    {
      kind: "select",
      name: "vendorId",
      label: t("fields.vendor"),
      blankLabel: t("fields.chooseVendor"),
      defaultValue: c?.vendorId ?? "",
      options: vendors.data.map((v) => ({ value: v.id, label: v.name ?? t("directory.unnamed") })),
    },
    {
      kind: "select",
      name: "projectId",
      label: t("fields.project"),
      blankLabel: t("scorecards.allProjects"),
      defaultValue: c?.projectId ?? "",
      options: projects.data.map((p) => ({ value: p.id, label: `${p.key} ${p.name}` })),
    },
    {
      kind: "date",
      name: "periodEnd",
      label: t("scorecards.periodEnd"),
      required: true,
      defaultValue: c?.periodEnd ?? "",
    },
    ...(["qualityScore", "deliveryScore", "safetyScore"] as const).map((name): FieldSpec => ({
      kind: "select",
      name,
      label: t(`scorecards.${name}`),
      blankLabel: t("scorecards.unscored"),
      defaultValue: c?.[name] === null || c?.[name] === undefined ? "" : String(c[name]),
      options: scoreOptions,
    })),
    { kind: "textarea", name: "note", label: t("scorecards.note"), defaultValue: c?.note ?? "" },
  ];
  const selected = state.peek ? cards.data.find((c) => c.id === state.peek) : undefined;
  const properties = (c: Scorecard) => [
    { label: t("fields.vendor"), value: c.vendorName ?? t("directory.unnamed") },
    {
      label: t("fields.project"),
      value: c.projectId
        ? (projectName.get(c.projectId) ?? t("scorecards.hiddenProject"))
        : t("scorecards.allProjects"),
    },
    { label: t("scorecards.periodEnd"), value: date(c.periodEnd) },
    { label: t("scorecards.qualityScore"), value: score(c.qualityScore) },
    { label: t("scorecards.deliveryScore"), value: score(c.deliveryScore) },
    { label: t("scorecards.safetyScore"), value: score(c.safetyScore) },
    { label: t("scorecards.average"), value: score(scorecardAverage(c)) },
  ];
  const controls = (c: Scorecard) =>
    canWrite ? (
      <ActionButton
        action={deleteScorecardAction}
        hidden={{ org: ctx.org.slug, id: c.id }}
        label={t("scorecards.delete")}
        variant="danger"
        confirm={{ title: t("scorecards.deleteTitle"), body: t("scorecards.deleteBody") }}
        refusals={REFUSALS}
      />
    ) : null;
  const editForm = (c: Scorecard) =>
    canWrite ? (
      <EntityForm
        id={`score-edit-${c.id}`}
        action={updateScorecardAction}
        hidden={{ org: ctx.org.slug, id: c.id }}
        refusals={REFUSALS}
        submitLabel={t("scorecards.save")}
        fields={fields(c)}
      />
    ) : null;
  const titleOf = (c: Scorecard) =>
    t("scorecards.recordTitle", {
      vendor: c.vendorName ?? t("directory.unnamed"),
      period: date(c.periodEnd),
    });

  if (selected && state.full) {
    return (
      <RecordPage
        backHref={withQuery(path, state)}
        backLabel={t("scorecards.back")}
        recordKey={date(selected.periodEnd)}
        title={titleOf(selected)}
        properties={properties(selected)}
        actions={controls(selected)}
      >
        {selected.note ? <p className="m-0 whitespace-pre-wrap">{selected.note}</p> : null}
        {editForm(selected)}
        <CollabPanels ctx={ctx} table="app.vendor_scorecards" id={selected.id} />
      </RecordPage>
    );
  }

  const rows: KitRow[] = cards.data.map((c) => ({
    id: c.id,
    key: date(c.periodEnd),
    title: c.vendorName ?? t("directory.unnamed"),
    meta: t("scorecards.averageLine", { average: score(scorecardAverage(c)) }),
    cells: {
      vendor: c.vendorName,
      period: date(c.periodEnd),
      quality: c.qualityScore,
      delivery: c.deliveryScore,
      safety: c.safetyScore,
      average: scorecardAverage(c),
    },
  }));

  const byVendor = new Map<string, number[]>();
  for (const c of cards.data) {
    const avg = scorecardAverage(c);
    if (avg === null) continue;
    const name = c.vendorName ?? t("directory.unnamed");
    byVendor.set(name, [...(byVendor.get(name) ?? []), avg]);
  }
  const vendorNames = [...byVendor.keys()].sort();

  let drawer = null;
  if (state.create && canWrite) {
    drawer = (
      <FormDrawer title={t("scorecards.create")} closeHref={withQuery(path, state)}>
        <EntityForm
          id="score-create"
          action={createScorecardAction}
          hidden={{ org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("scorecards.create")}
          successHref={withQuery(path, state, { peek: "{id}" })}
          fields={fields()}
        />
      </FormDrawer>
    );
  } else if (selected) {
    drawer = (
      <PeekDrawer
        recordKey={date(selected.periodEnd)}
        title={titleOf(selected)}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id, full: "1" })}
        properties={properties(selected)}
        actions={controls(selected)}
      >
        {selected.note ? <p className="m-0 whitespace-pre-wrap">{selected.note}</p> : null}
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
        { key: "period", label: t("scorecards.periodEnd") },
        { key: "quality", label: t("scorecards.qualityScore"), type: "number" },
        { key: "delivery", label: t("scorecards.deliveryScore"), type: "number" },
        { key: "safety", label: t("scorecards.safetyScore"), type: "number" },
        { key: "average", label: t("scorecards.average"), type: "number" },
      ]}
      rows={rows}
      chart={{
        title: t("scorecards.chartTitle"),
        categoryLabel: t("fields.vendor"),
        categories: vendorNames,
        series: [
          {
            name: t("scorecards.average"),
            values: vendorNames.map((n) => {
              const values = byVendor.get(n) ?? [];
              return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
            }),
          },
        ],
      }}
      actions={
        canWrite ? (
          <KitLink href={withQuery(path, state, { create: "1" })} variant="primary">
            {t("scorecards.create")}
          </KitLink>
        ) : null
      }
      empty={emptyFor(t, canWrite, withQuery(path, state, { create: "1" }), "scorecards")}
    >
      {drawer}
    </CollectionView>
  );
}
