import { explainAccess, type AccessPath } from "@xos/data/access";
import {
  boardField,
  calendarField,
  getObjectType,
  listObjectRecords,
  type FieldValue,
  type ObjectField,
  type ObjectRecord,
} from "@xos/data/custom-objects";
import { isNodeVisible } from "@xos/ia";
import type { RecordState } from "@xos/ui";
import { notFound } from "next/navigation";
import { CollectionView } from "@/components/collection-kit/collection-view";
import type {
  KitBoardColumn,
  KitColumn,
  KitRow,
  ViewKind,
} from "@/components/collection-kit/types";
import { CreateRecordDrawer, RecordPeek, type PeekField } from "@/components/objects/records";
import { EmptyPanel, ErrorPanel } from "@/components/platform/kit";
import { PageHeader, TemplateCollection } from "@/components/platform/ui";
import { ButtonLink } from "@/components/ui";
import { collectionState } from "@/lib/collection-kit/page";
import { getFormatters, type Formatters } from "@/lib/platform/format";
import { getOrgContext } from "@/lib/shell/context";
import { sitemap } from "@/lib/shell/sitemap";

const BOARD_STATES: readonly RecordState[] = [
  "proposed",
  "in-review",
  "active",
  "scheduled",
  "complete",
  "deferred",
  "canceled",
];

function show(f: ObjectField, v: FieldValue | undefined, fmt: Formatters): string | null {
  if (!v) return null;
  switch (v.kind) {
    case "choice":
      return f.choices.find((c) => c.id === v.choiceId)?.label ?? null;
    case "money":
      return fmt.money(v.minor, v.currency);
    case "date":
      return fmt.date(v.value);
    case "timestamp":
      return fmt.dateTime(v.value);
    case "boolean":
      return fmt.t(v.value ? "common.yes" : "common.no");
    case "number":
      return fmt.number(v.value);
    case "text":
      return v.value;
    case "person":
      return fmt.t("objects.person");
  }
}

/**
 * Records of a custom object (Section 4.6.3): list, board (by its first Choice field), table and
 * calendar (by its first date field) views, only those the object's fields support; a create drawer
 * from the object's typed fields; and a record peek that explains why the viewer can see the record.
 */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/objects/[objectKey]">) {
  const { org, objectKey } = await params;
  const ctx = await getOrgContext(org);
  if (!ctx || !isNodeVisible(sitemap, "custom-object", ctx.nav)) notFound();
  const type = await getObjectType(ctx.viewer.db, ctx.org.id, objectKey);
  if (!type.ok) {
    if (type.error.kind === "not-found") notFound();
    const { t } = await getFormatters(ctx);
    return (
      <TemplateCollection header={<PageHeader title={t("objects.title")} />}>
        <ErrorPanel sentence={t("objects.loadError")} />
      </TemplateCollection>
    );
  }
  const fmt = await getFormatters(ctx);
  const { t } = fmt;
  const object = type.data;
  const board = boardField(object);
  const calendar = calendarField(object);
  const views: ViewKind[] = [
    "list",
    ...(board ? (["board"] as const) : []),
    "table",
    ...(calendar ? (["calendar"] as const) : []),
  ];
  const preferred = object.defaultView.toLowerCase() as ViewKind;
  const query = await searchParams;
  const state = collectionState(
    query["view"] ? query : { ...query, view: views.includes(preferred) ? preferred : "list" },
    views,
  );
  const records = await listObjectRecords(ctx.viewer.db, object);
  if (!records.ok) {
    return (
      <TemplateCollection header={<PageHeader title={object.label} />}>
        <ErrorPanel sentence={t("objects.loadError")} />
      </TemplateCollection>
    );
  }
  const ordered = [...records.data].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const keyOf = new Map(
    ordered.map((r, i) => [r.id, `${object.key.toUpperCase().replaceAll("_", "-")}-${i + 1}`]),
  );
  const columns: KitColumn[] = [
    { key: "title", label: t("objects.titleColumn") },
    ...object.fields.map((f) => ({ key: f.id, label: f.label })),
  ];
  const boardColumns: KitBoardColumn[] | undefined = board
    ? board.choices.map((c, i) => ({
        value: c.id,
        label: c.label,
        state: BOARD_STATES[i % BOARD_STATES.length] ?? "proposed",
      }))
    : undefined;
  const rows: KitRow[] = records.data.map((r: ObjectRecord) => {
    const boardValue = board ? r.values[board.id] : undefined;
    const date = calendar ? r.values[calendar.id] : undefined;
    const firstOther = object.fields.find((f) => f.id !== board?.id && r.values[f.id]);
    const meta = firstOther ? show(firstOther, r.values[firstOther.id], fmt) : null;
    return {
      id: r.id,
      key: keyOf.get(r.id) ?? "",
      title: r.title,
      ...(boardValue?.kind === "choice" ? { boardValue: boardValue.choiceId } : {}),
      ...(date && (date.kind === "date" || date.kind === "timestamp")
        ? { date: date.value.slice(0, 10) }
        : {}),
      ...(meta ? { meta } : {}),
      cells: {
        title: r.title,
        ...Object.fromEntries(object.fields.map((f) => [f.id, show(f, r.values[f.id], fmt)])),
      },
    };
  });

  const canWrite =
    ctx.role !== null && ["owner", "admin", "manager", "member", "collaborator"].includes(ctx.role);
  const peeked = state.peek ? (records.data.find((r) => r.id === state.peek) ?? null) : null;
  let paths: AccessPath[] | null = null;
  if (peeked) {
    const explained = await explainAccess(ctx.viewer.db, "custom_object_records", peeked.id);
    paths = explained.ok ? explained.data : null;
  }
  const base = `/${ctx.org.slug}/objects/${object.key}`;
  const close = state.baseQuery ? `${base}?${state.baseQuery}` : base;
  const peekFields: PeekField[] = peeked
    ? object.fields.map((f) => ({
        id: f.id,
        label: f.label,
        value: show(f, peeked.values[f.id], fmt),
        choices:
          f.dataType === "Choice" ? f.choices.map((c) => ({ value: c.id, label: c.label })) : null,
        current:
          peeked.values[f.id]?.kind === "choice"
            ? (peeked.values[f.id] as { choiceId: string }).choiceId
            : null,
      }))
    : [];

  return (
    <CollectionView
      // The board keeps its cards in state; a new key remounts it when the records change.
      key={JSON.stringify(records.data.map((r) => [r.id, r.title, r.values]))}
      title={object.label}
      views={views}
      view={state.view}
      columns={columns}
      rows={rows}
      {...(boardColumns ? { board: boardColumns } : {})}
      month={state.month}
      actions={
        canWrite ? (
          <ButtonLink href={`${base}?create=1`} variant="primary">
            {t("objects.create", { object: object.label })}
          </ButtonLink>
        ) : undefined
      }
      empty={
        <EmptyPanel
          icon="Box"
          sentence={t("objects.empty", { object: object.label })}
          actionLabel={
            canWrite ? t("objects.create", { object: object.label }) : t("objects.emptyReadOnly")
          }
          href={canWrite ? `${base}?create=1` : `/${ctx.org.slug}/home`}
        />
      }
    >
      {state.create && canWrite ? (
        <CreateRecordDrawer
          org={ctx.org.slug}
          objectKey={object.key}
          label={object.label}
          fields={object.fields.map((f) => ({
            id: f.id,
            label: f.label,
            dataType: f.dataType,
            required: f.required,
            choices: f.choices.map((c) => ({ value: c.id, label: c.label })),
          }))}
          closeHref={close}
        />
      ) : null}
      {peeked ? (
        <RecordPeek
          org={ctx.org.slug}
          objectKey={object.key}
          recordId={peeked.id}
          recordKey={keyOf.get(peeked.id) ?? ""}
          title={peeked.title}
          fields={peekFields}
          paths={paths}
          canWrite={canWrite}
          closeHref={close}
        />
      ) : null}
    </CollectionView>
  );
}
