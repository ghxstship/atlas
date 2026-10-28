import { listElements } from "@xos/data/canon";
import {
  listCatalogBindings,
  listCurrencies,
  listVendorProducts,
  type CatalogBinding,
} from "@xos/data/procurement";
import { listVendors } from "@xos/data/vendors";
import { getFormatter } from "next-intl/server";
import {
  createBindingAction,
  createProductAction,
  deleteBindingAction,
  deleteProductAction,
  updateBindingAction,
} from "@/app/[org]/procurement/actions";
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
  type FieldSpec,
} from "@/components/collection-kit/kit";
import type { KitRow, ViewKind } from "@/components/collection-kit/types";
import { PageHeader } from "@/components/collection-kit/ui";
import { minorToInput } from "@/lib/collection-kit/forms";
import { getCopy, type Copy } from "@/lib/collection-kit/i18n";
import {
  collectionState,
  formatMinor,
  withQuery,
  type SearchParams,
} from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import { CollectionPage } from "@/components/platform/collection-page";

const VIEWS: readonly ViewKind[] = ["table", "list", "gallery"];
const REFUSALS = "procurement.refusals";

/**
 * Procurement > Catalog: the org's catalog items bound to canon elements (Section 7.4), each with
 * its {URID}-{ORG}-{SEQ} item ID issued by the database, a default price that stays NULL until
 * known, and the vendors' products that fulfill it. Canon elements are read-only (Canon > Elements).
 */
export async function CatalogSection({
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
  const [t, format, bindings, currencies, vendors] = await Promise.all([
    getCopy("procurement"),
    getFormatter(),
    listCatalogBindings(db, ctx.org.id),
    listCurrencies(db),
    listVendors(db, ctx.org.id),
  ]);
  const title = t("catalog.title");
  if (!bindings.ok || !currencies.ok || !vendors.ok) {
    return (
      <CollectionPage header={<PageHeader title={title} />}>
        <ErrorPanel what={t("catalog.what")} />
      </CollectionPage>
    );
  }
  const canWrite = ctx.capabilities.has("procurement.catalog.write");
  const exponent = new Map(currencies.data.map((c) => [c.code, c.minorUnits]));
  const price = (minor: number | null, currency: string | null) =>
    formatMinor(format, minor, currency, exponent.get(currency ?? "") ?? 2, t("money.unpriced"));
  const currencyOptions = currencies.data.map((c) => ({ value: c.code, label: c.code }));
  const bindingFields = (b?: CatalogBinding): FieldSpec[] => [
    {
      kind: "text",
      name: "name",
      label: t("catalog.name"),
      required: true,
      defaultValue: b?.name ?? "",
    },
    {
      kind: "text",
      name: "unitBasis",
      label: t("lines.unitBasis"),
      help: t("lines.unitBasisHelp"),
      defaultValue: b?.unitBasis ?? "",
    },
    {
      kind: "money",
      name: "defaultPrice",
      label: t("catalog.defaultPrice"),
      defaultValue: b
        ? minorToInput(b.defaultUnitPriceMinor, exponent.get(b.currencyCode ?? "") ?? 2)
        : "",
    },
    {
      kind: "select",
      name: "currencyCode",
      label: t("fields.currency"),
      blankLabel: t("catalog.noCurrency"),
      defaultValue: b?.currencyCode ?? "",
      options: currencyOptions,
    },
  ];
  const selected = state.peek ? bindings.data.find((b) => b.id === state.peek) : undefined;
  const properties = (b: CatalogBinding) => [
    { label: t("catalog.itemId"), value: b.itemId },
    { label: t("catalog.element"), value: `${b.elementId} ${b.elementName ?? ""}`.trim() },
    { label: t("catalog.urid"), value: b.urid ?? t("catalog.noUrid") },
    { label: t("lines.unitBasis"), value: b.unitBasis ?? t("catalog.noUnit") },
    { label: t("catalog.defaultPrice"), value: price(b.defaultUnitPriceMinor, b.currencyCode) },
  ];
  const controls = (b: CatalogBinding) =>
    canWrite ? (
      <ActionButton
        action={deleteBindingAction}
        hidden={{ org: ctx.org.slug, id: b.id }}
        label={t("catalog.delete")}
        variant="danger"
        confirm={{
          title: t("catalog.deleteTitle", { item: b.itemId }),
          body: t("catalog.deleteBody"),
        }}
        refusals={REFUSALS}
      />
    ) : null;
  const products = async (b: CatalogBinding) => {
    const list = await listVendorProducts(db, { catalogBindingId: b.id });
    return (
      <KitSection id={`products-${b.id}`} title={t("catalog.products")}>
        {!list.ok ? (
          <ErrorPanel what={t("catalog.products")} />
        ) : list.data.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">{t("catalog.noProducts")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {list.data.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-8 py-8 text-text-13"
              >
                <span>
                  {p.vendorName ?? t("fields.unnamedVendor")} ·{" "}
                  <span className="font-mono">{p.vendorSku}</span> ·{" "}
                  {price(p.unitPriceMinor, p.currencyCode)}
                  {p.leadTimeDays !== null
                    ? ` · ${t("catalog.leadTime", { days: p.leadTimeDays })}`
                    : ""}
                </span>
                {canWrite ? (
                  <ActionButton
                    action={deleteProductAction}
                    hidden={{ org: ctx.org.slug, id: p.id }}
                    label={t("catalog.removeProduct")}
                    refusals={REFUSALS}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canWrite && vendors.data.length > 0 ? (
          <EntityForm
            id={`product-add-${b.id}`}
            action={createProductAction}
            hidden={{ org: ctx.org.slug, catalogBindingId: b.id }}
            refusals={REFUSALS}
            submitLabel={t("catalog.addProduct")}
            fields={[
              {
                kind: "select",
                name: "vendorId",
                label: t("fields.vendor"),
                options: vendors.data.map((v) => ({
                  value: v.id,
                  label: v.name ?? t("fields.unnamedVendor"),
                })),
              },
              {
                kind: "text",
                name: "vendorSku",
                label: t("catalog.sku"),
                required: true,
                help: t("catalog.skuHelp"),
              },
              { kind: "money", name: "unitPrice", label: t("lines.unitPrice") },
              {
                kind: "select",
                name: "currencyCode",
                label: t("fields.currency"),
                blankLabel: t("catalog.noCurrency"),
                defaultValue: b.currencyCode ?? "",
                options: currencyOptions,
              },
              { kind: "number", name: "leadTimeDays", label: t("catalog.leadTimeDays") },
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
        backLabel={t("catalog.back")}
        recordKey={selected.itemId}
        title={selected.name}
        properties={properties(selected)}
        actions={controls(selected)}
      >
        {canWrite ? (
          <KitSection id="binding-edit" title={t("catalog.details")}>
            <EntityForm
              id={`binding-edit-${selected.id}`}
              action={updateBindingAction}
              hidden={{ org: ctx.org.slug, id: selected.id }}
              refusals={REFUSALS}
              submitLabel={t("catalog.save")}
              fields={bindingFields(selected)}
            />
          </KitSection>
        ) : null}
        {await products(selected)}
        <CollabPanels ctx={ctx} table="app.catalog_bindings" id={selected.id} />
      </RecordPage>
    );
  }

  const rows: KitRow[] = bindings.data.map((b) => ({
    id: b.id,
    key: b.itemId,
    title: b.name,
    meta: price(b.defaultUnitPriceMinor, b.currencyCode),
    cells: {
      item: b.itemId,
      name: b.name,
      element: b.elementName,
      unit: b.unitBasis,
      price: price(b.defaultUnitPriceMinor, b.currencyCode),
    },
  }));

  let drawer = null;
  if (state.create && canWrite) {
    drawer = (
      <CreateBinding
        ctx={ctx}
        t={t}
        path={path}
        search={search}
        closeHref={withQuery(path, state)}
        fields={bindingFields()}
      />
    );
  } else if (selected) {
    drawer = (
      <PeekDrawer
        recordKey={selected.itemId}
        title={selected.name}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id, full: "1" })}
        properties={properties(selected)}
        actions={controls(selected)}
      >
        {await products(selected)}
      </PeekDrawer>
    );
  }

  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "item", label: t("catalog.itemId"), type: "code" },
        { key: "name", label: t("catalog.name") },
        { key: "element", label: t("catalog.element") },
        { key: "unit", label: t("lines.unitBasis") },
        { key: "price", label: t("catalog.defaultPrice") },
      ]}
      rows={rows}
      actions={
        canWrite ? (
          <KitLink href={withQuery(path, state, { create: "1" })} variant="primary">
            {t("catalog.create")}
          </KitLink>
        ) : null
      }
      empty={emptyFor(t, canWrite, withQuery(path, state, { create: "1" }), "catalog")}
    >
      {drawer}
    </CollectionView>
  );
}

async function CreateBinding({
  ctx,
  t,
  path,
  search,
  closeHref,
  fields,
}: {
  ctx: OrgContext;
  t: Copy;
  path: string;
  search: SearchParams;
  closeHref: string;
  fields: FieldSpec[];
}) {
  const query = typeof search["element"] === "string" ? search["element"] : "";
  const found = query.trim() ? await listElements(ctx.viewer.db, { query }) : null;
  return (
    <FormDrawer title={t("catalog.create")} closeHref={closeHref}>
      <form method="get" action={path} className="flex flex-wrap items-end gap-8" role="search">
        <input type="hidden" name="create" value="1" />
        <div className="flex flex-col gap-4">
          <label htmlFor="element-search" className="text-label-13 font-medium">
            {t("catalog.findElement")}
          </label>
          <input
            id="element-search"
            name="element"
            type="search"
            defaultValue={query}
            className="h-control-md rounded-control border border-border-control bg-bg-surface px-8 text-text-13"
          />
        </div>
        <button
          type="submit"
          className="h-control-md rounded-control border border-border-control bg-bg-surface px-12 text-text-13 font-medium"
        >
          {t("catalog.search")}
        </button>
      </form>
      {found === null ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("catalog.searchHelp")}</p>
      ) : !found.ok ? (
        <ErrorPanel what={t("catalog.elements")} />
      ) : found.data.elements.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("catalog.noElements")}</p>
      ) : (
        <EntityForm
          id="binding-create"
          action={createBindingAction}
          hidden={{ org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("catalog.create")}
          successHref={`${path}?peek={id}`}
          fields={[
            {
              kind: "select",
              name: "elementId",
              label: t("catalog.element"),
              help: t("catalog.elementCount", {
                shown: found.data.elements.length,
                total: found.data.total,
              }),
              options: found.data.elements.map((e) => ({
                value: e.id,
                label: `${e.id} ${e.name}`,
              })),
            },
            ...fields,
          ]}
        />
      )}
    </FormDrawer>
  );
}
