import { listStandardVerbiage, listVerbiageTerms, type VerbiageTerm } from "@xos/data/knowledge";
import {
  createTermAction,
  deleteTermAction,
  updateTermAction,
} from "@/app/[org]/knowledge/actions";
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

const VIEWS: readonly ViewKind[] = ["table", "list"];
const REFUSALS = "knowledge.refusals";

/**
 * Knowledge > Verbiage library: the org's controlled vocabulary with casing rules. Definitions are
 * sentences ending in a period and no text carries an em dash (invariant 24); the form explains
 * both before the database refuses. Terms can start from the XOS Standard Library.
 */
export async function VerbiageSection({
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
  const [t, terms] = await Promise.all([getCopy("knowledge"), listVerbiageTerms(db, ctx.org.id)]);
  const title = t("verbiage.title");
  if (!terms.ok) {
    return (
      <>
        <PageHeader title={title} />
        <ErrorPanel what={t("verbiage.what")} />
      </>
    );
  }
  const canWrite = ctx.capabilities.has("knowledge.verbiage.write");
  const fields = (v?: Partial<VerbiageTerm>): FieldSpec[] => [
    {
      kind: "text",
      name: "term",
      label: t("verbiage.term"),
      required: true,
      defaultValue: v?.term ?? "",
    },
    {
      kind: "text",
      name: "casingRule",
      label: t("verbiage.casing"),
      required: true,
      help: t("verbiage.casingHelp"),
      defaultValue: v?.casingRule ?? "",
    },
    {
      kind: "textarea",
      name: "definition",
      label: t("verbiage.definition"),
      required: true,
      help: t("verbiage.definitionHelp"),
      defaultValue: v?.definition ?? "",
    },
  ];
  const selected = state.peek ? terms.data.find((v) => v.id === state.peek) : undefined;
  const properties = (v: VerbiageTerm) => [
    { label: t("verbiage.casing"), value: v.casingRule },
    { label: t("verbiage.definition"), value: v.definition },
  ];
  const controls = (v: VerbiageTerm) =>
    canWrite ? (
      <ActionButton
        action={deleteTermAction}
        hidden={{ org: ctx.org.slug, id: v.id }}
        label={t("verbiage.delete")}
        variant="danger"
        confirm={{
          title: t("verbiage.deleteTitle", { term: v.term }),
          body: t("verbiage.deleteBody"),
        }}
        refusals={REFUSALS}
      />
    ) : null;
  const editForm = (v: VerbiageTerm) =>
    canWrite ? (
      <EntityForm
        id={`term-edit-${v.id}`}
        action={updateTermAction}
        hidden={{ org: ctx.org.slug, id: v.id }}
        refusals={REFUSALS}
        submitLabel={t("verbiage.save")}
        fields={fields(v)}
      />
    ) : null;

  if (selected && state.full) {
    return (
      <RecordPage
        backHref={withQuery(path, state)}
        backLabel={t("verbiage.back")}
        recordKey={t("verbiage.termKey")}
        title={selected.term}
        properties={properties(selected)}
        actions={controls(selected)}
      >
        {editForm(selected)}
      </RecordPage>
    );
  }

  const rows: KitRow[] = terms.data.map((v) => ({
    id: v.id,
    key: v.casingRule,
    title: v.term,
    meta: v.definition,
    cells: { term: v.term, casing: v.casingRule, definition: v.definition },
  }));

  let drawer = null;
  if (state.create && canWrite) {
    const standard = await listStandardVerbiage(db);
    const from = typeof search["from"] === "string" ? search["from"] : "";
    const chosen = standard.ok ? standard.data.find((s) => s.id === from) : undefined;
    drawer = (
      <FormDrawer title={t("verbiage.create")} closeHref={withQuery(path, state)}>
        {standard.ok && standard.data.length > 0 ? (
          <form method="get" action={path} className="flex flex-wrap items-end gap-8">
            <input type="hidden" name="create" value="1" />
            <div className="flex flex-col gap-4">
              <label htmlFor="term-from" className="text-label-13 font-medium">
                {t("verbiage.startFrom")}
              </label>
              <select
                id="term-from"
                name="from"
                defaultValue={from}
                className="h-control-md max-w-full rounded-control border border-border-control bg-bg-surface px-8 text-text-13"
              >
                <option value="">{t("verbiage.blank")}</option>
                {standard.data.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.term}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="h-control-md rounded-control border border-border-control bg-bg-surface px-12 text-text-13 font-medium"
            >
              {t("verbiage.useTemplate")}
            </button>
          </form>
        ) : null}
        <EntityForm
          id="term-create"
          action={createTermAction}
          hidden={{ org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("verbiage.create")}
          successHref={withQuery(path, state, { peek: "{id}" })}
          fields={fields(
            chosen ? { term: chosen.term, definition: chosen.definition ?? "" } : undefined,
          )}
        />
      </FormDrawer>
    );
  } else if (selected) {
    drawer = (
      <PeekDrawer
        recordKey={t("verbiage.termKey")}
        title={selected.term}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id, full: "1" })}
        properties={properties(selected)}
        actions={controls(selected)}
      >
        {editForm(selected)}
      </PeekDrawer>
    );
  }

  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "term", label: t("verbiage.term") },
        { key: "casing", label: t("verbiage.casing") },
        { key: "definition", label: t("verbiage.definition"), wrap: true },
      ]}
      rows={rows}
      actions={
        canWrite ? (
          <KitLink href={withQuery(path, state, { create: "1" })} variant="primary">
            {t("verbiage.create")}
          </KitLink>
        ) : null
      }
      empty={emptyFor(t, canWrite, withQuery(path, state, { create: "1" }), "verbiage")}
    >
      {drawer}
    </CollectionView>
  );
}
