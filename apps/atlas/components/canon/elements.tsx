import { ELEMENT_PAGE_SIZE, listElements } from "@xos/data/canon";
import { CollectionView } from "@/components/collection-kit/collection-view";
import {
  EmptyRefresh,
  ErrorPanel,
  KitLink,
  PeekDrawer,
  RecordPage,
} from "@/components/collection-kit/kit";
import type { KitRow, ViewKind } from "@/components/collection-kit/types";
import { InlineAlert, PageHeader } from "@/components/collection-kit/ui";
import { getCopy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";

const VIEWS: readonly ViewKind[] = ["table", "list", "gallery"];

/**
 * Canon > Elements: the 1,211 catalog elements, searched and paged on the server (item, common name,
 * element ID or URID, and a URID prefix). Read-only; an org binds elements into its own catalog
 * under Procurement > Catalog.
 */
export async function CanonElements({
  ctx,
  path,
  search,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
}) {
  const state = collectionState(search, VIEWS);
  const query = typeof search["q"] === "string" ? search["q"] : "";
  const prefix = typeof search["urid"] === "string" ? search["urid"] : "";
  const page = Math.max(
    0,
    Number.parseInt(typeof search["page"] === "string" ? search["page"] : "0", 10) || 0,
  );
  const [t, result] = await Promise.all([
    getCopy("canonBrowser"),
    listElements(ctx.viewer.db, { query, uridPrefix: prefix, page }),
  ]);
  const title = t("elements.title");
  if (!result.ok) {
    return (
      <>
        <PageHeader title={title} />
        <ErrorPanel what={t("what")} />
      </>
    );
  }
  const { elements, total } = result.data;
  const hours = (h: number | null) => (h === null ? t("none") : t("elements.hours", { hours: h }));
  const selected = state.peek ? elements.find((e) => e.id === state.peek) : undefined;
  const properties = (e: (typeof elements)[number]) => [
    { label: t("fields.urid"), value: e.urid },
    { label: t("elements.commonName"), value: e.commonName ?? t("none") },
    { label: t("elements.unit"), value: e.unitBasis },
    { label: t("elements.grade"), value: e.grade },
    { label: t("elements.tier"), value: e.tierCode },
    { label: t("elements.leadTime"), value: hours(e.leadTimeHours) },
    { label: t("elements.description"), value: e.description ?? t("none") },
  ];
  if (selected && state.full) {
    return (
      <RecordPage
        backHref={withQuery(path, state)}
        backLabel={t("back", { page: title })}
        recordKey={selected.id}
        title={selected.name}
        properties={properties(selected)}
      >
        <InlineAlert tone="info">{t("readOnly")}</InlineAlert>
      </RecordPage>
    );
  }
  const rows: KitRow[] = elements.map((e) => ({
    id: e.id,
    key: e.id,
    title: e.name,
    meta: `${e.urid} · ${e.unitBasis}`,
    cells: {
      id: e.id,
      name: e.name,
      urid: e.urid,
      unit: e.unitBasis,
      grade: e.grade,
      lead: hours(e.leadTimeHours),
    },
  }));
  const pageHref = (n: number) => withQuery(path, state, { page: String(n) });
  const pages = Math.max(1, Math.ceil(total / ELEMENT_PAGE_SIZE));
  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      searchable={false}
      columns={[
        { key: "id", label: t("elements.itemId"), type: "code" },
        { key: "name", label: t("fields.name") },
        { key: "urid", label: t("fields.urid"), type: "code" },
        { key: "unit", label: t("elements.unit") },
        { key: "grade", label: t("elements.grade") },
        { key: "lead", label: t("elements.leadTime") },
      ]}
      rows={rows}
      filters={
        <form method="get" action={path} role="search" className="flex flex-wrap items-end gap-8">
          {state.view !== "table" ? <input type="hidden" name="view" value={state.view} /> : null}
          <div className="flex flex-col gap-4">
            <label htmlFor="element-q" className="text-label-13 font-medium">
              {t("elements.search")}
            </label>
            <input
              id="element-q"
              name="q"
              type="search"
              defaultValue={query}
              className="h-control-md rounded-control border border-border-control bg-bg-surface px-8 text-text-13"
            />
          </div>
          <div className="flex flex-col gap-4">
            <label htmlFor="element-urid" className="text-label-13 font-medium">
              {t("elements.uridPrefix")}
            </label>
            <input
              id="element-urid"
              name="urid"
              inputMode="decimal"
              defaultValue={prefix}
              className="h-control-md w-[calc(var(--space-40)*3)] rounded-control border border-border-control bg-bg-surface px-8 text-text-13"
            />
          </div>
          <button
            type="submit"
            className="h-control-md rounded-control border border-border-control bg-bg-surface px-12 text-text-13 font-medium"
          >
            {t("elements.apply")}
          </button>
          <p role="status" className="m-0 text-text-12 text-text-secondary">
            {t("elements.pageStatus", { page: page + 1, pages, total })}
          </p>
          {page > 0 ? (
            <KitLink href={pageHref(page - 1)} size="sm">
              {t("elements.previous")}
            </KitLink>
          ) : null}
          {page + 1 < pages ? (
            <KitLink href={pageHref(page + 1)} size="sm">
              {t("elements.next")}
            </KitLink>
          ) : null}
        </form>
      }
      empty={<EmptyRefresh icon="SearchX" sentence={t("elements.noMatches")} />}
    >
      {selected ? (
        <PeekDrawer
          recordKey={selected.id}
          title={selected.name}
          closeHref={withQuery(path, state)}
          fullHref={withQuery(path, state, { peek: selected.id, full: "1" })}
          properties={properties(selected)}
        />
      ) : null}
    </CollectionView>
  );
}
