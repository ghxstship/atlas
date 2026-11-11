import { listStandardVendorClasses, listVendorClasses } from "@xos/data/vendors";
import {
  createVendorClassAction,
  deleteVendorClassAction,
  updateVendorClassAction,
} from "@/app/[org]/vendors/actions";
import { CollectionView } from "@/components/collection-kit/collection-view";
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
import { emptyFor } from "@/components/collection-kit/empty";
import { RecordHistory } from "@/components/history/record-history";
import { getCopy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import { CollectionPage } from "@/components/platform/collection-page";

const VIEWS: readonly ViewKind[] = ["table", "list"];
const REFUSALS = "vendors.refusals";

/**
 * Vendors > Classes: the classes the org sorts vendors into, optionally adopted from the XOS
 * Standard Library (xpms.std_vendor_class, read-only canon). Editing needs vendors.class.write.
 */
export async function VendorClasses({
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
  const [t, classes, standard] = await Promise.all([
    getCopy("vendors"),
    listVendorClasses(db, ctx.org.id),
    listStandardVendorClasses(db),
  ]);
  const title = t("classes.title");
  if (!classes.ok || !standard.ok) {
    return (
      <CollectionPage header={<PageHeader title={title} />}>
        <ErrorPanel what={t("classes.what")} />
      </CollectionPage>
    );
  }
  const canWrite = ctx.capabilities.has("vendors.class.write");
  const stdName = new Map(standard.data.map((s) => [s.id, s.name]));
  const fields = (defaults?: {
    name: string;
    description: string | null;
    std: string | null;
  }): FieldSpec[] => [
    {
      kind: "text",
      name: "name",
      label: t("fields.name"),
      required: true,
      defaultValue: defaults?.name ?? "",
    },
    {
      kind: "textarea",
      name: "description",
      label: t("fields.description"),
      defaultValue: defaults?.description ?? "",
    },
    {
      kind: "select",
      name: "stdVendorClassId",
      label: t("classes.standard"),
      help: t("classes.standardHelp"),
      blankLabel: t("classes.noStandard"),
      defaultValue: defaults?.std ?? "",
      options: standard.data.map((s) => ({ value: s.id, label: `${s.id} ${s.name}` })),
    },
  ];
  const selected = state.peek ? classes.data.find((c) => c.id === state.peek) : undefined;
  const properties = (c: NonNullable<typeof selected>) => [
    { label: t("fields.description"), value: c.description ?? t("classes.noDescription") },
    {
      label: t("classes.standard"),
      value: c.stdVendorClassId
        ? (stdName.get(c.stdVendorClassId) ?? c.stdVendorClassId)
        : t("classes.noStandard"),
    },
    { label: t("classes.vendors"), value: String(c.vendorCount) },
  ];
  const editForm = (c: NonNullable<typeof selected>) =>
    canWrite ? (
      <EntityForm
        id={`class-edit-${c.id}`}
        action={updateVendorClassAction}
        hidden={{ org: ctx.org.slug, id: c.id }}
        refusals={REFUSALS}
        submitLabel={t("classes.save")}
        fields={fields({ name: c.name, description: c.description, std: c.stdVendorClassId })}
      />
    ) : null;
  const deleteButton = (c: NonNullable<typeof selected>) =>
    canWrite ? (
      <ActionButton
        action={deleteVendorClassAction}
        hidden={{ org: ctx.org.slug, id: c.id }}
        label={t("classes.delete")}
        variant="danger"
        confirm={{
          title: t("classes.deleteTitle", { name: c.name }),
          body: t("classes.deleteBody"),
        }}
        refusals={REFUSALS}
      />
    ) : null;

  if (selected && state.full) {
    return (
      <RecordPage
        backHref={withQuery(path, state)}
        backLabel={t("classes.back")}
        recordKey={selected.stdVendorClassId ?? t("classes.orgClass")}
        title={selected.name}
        properties={properties(selected)}
        actions={deleteButton(selected)}
      >
        {editForm(selected)}
        <RecordHistory db={db} table="app.vendor_classes" id={selected.id} />
      </RecordPage>
    );
  }

  const rows: KitRow[] = classes.data.map((c) => ({
    id: c.id,
    key: c.stdVendorClassId ?? t("classes.orgClass"),
    title: c.name,
    meta: t("classes.vendorCount", { count: c.vendorCount }),
    cells: {
      name: c.name,
      standard: c.stdVendorClassId ? (stdName.get(c.stdVendorClassId) ?? c.stdVendorClassId) : null,
      vendors: c.vendorCount,
      description: c.description,
    },
  }));

  let drawer = null;
  if (state.create && canWrite) {
    drawer = (
      <FormDrawer title={t("classes.create")} closeHref={withQuery(path, state)}>
        <EntityForm
          id="class-create"
          action={createVendorClassAction}
          hidden={{ org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("classes.create")}
          successHref={withQuery(path, state, { peek: "{id}" })}
          fields={fields()}
        />
      </FormDrawer>
    );
  } else if (selected) {
    drawer = (
      <PeekDrawer
        recordKey={selected.stdVendorClassId ?? t("classes.orgClass")}
        title={selected.name}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id, full: "1" })}
        properties={properties(selected)}
        actions={deleteButton(selected)}
      >
        {editForm(selected)}
        <RecordHistory db={db} table="app.vendor_classes" id={selected.id} />
      </PeekDrawer>
    );
  }

  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "name", label: t("fields.name") },
        { key: "standard", label: t("classes.standard") },
        { key: "vendors", label: t("classes.vendors"), type: "number" },
        { key: "description", label: t("fields.description"), wrap: true },
      ]}
      rows={rows}
      actions={
        canWrite ? (
          <KitLink href={withQuery(path, state, { create: "1" })} variant="primary">
            {t("classes.create")}
          </KitLink>
        ) : null
      }
      empty={emptyFor(t, canWrite, withQuery(path, state, { create: "1" }), "classes")}
    >
      {drawer}
    </CollectionView>
  );
}
