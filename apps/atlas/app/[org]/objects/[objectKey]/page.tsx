import { explainAccess, type AccessPath } from "@xos/data/access";
import type { Json } from "@xos/data/database.types";
import { getFieldHistory } from "@xos/data/field-history";
import {
  boardField,
  calendarField,
  getObjectType,
  listObjectRecords,
  type FieldValue,
  type ObjectField,
  type ObjectRecord,
  type ObjectType,
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
import type { HistoryItem } from "@/components/history/field-history-list";
import { CreateRecordDrawer, RecordPeek, type PeekField } from "@/components/objects/records";
import { EmptyPanel, ErrorPanel } from "@/components/platform/kit";
import { PageHeader, TemplateCollection } from "@/components/platform/client/page-header";
import { ButtonLink } from "@/components/ui";
import { loadConversation, type Conversation } from "@/components/work/record-sections";
import { historyItems } from "@/lib/history/items";
import { collectionState } from "@/lib/collection-kit/page";
import { getFormatters, type Formatters } from "@/lib/platform/format";
import { getOrgContext, type OrgContext } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";
import { PageSkeleton } from "@/components/projects/page-skeleton";
import { Suspense } from "react";
import { sitemap } from "@/lib/shell/sitemap";
import { orgToday } from "@/lib/shell/time-zone";

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
 * A value as the record's history stores it (1750: a choice or person as its id, money as its minor
 * units and currency), in words.
 */
function historyValue(f: ObjectField | undefined, v: Json, fmt: Formatters): string {
  if (!f) return typeof v === "string" ? v : JSON.stringify(v);
  switch (f.dataType) {
    case "Choice":
      return f.choices.find((c) => c.id === v)?.label ?? String(v);
    case "Money": {
      const m = v as { minor: number | null; currency: string };
      return fmt.money(m.minor, m.currency);
    }
    case "Date":
      return fmt.date(String(v));
    case "Timestamp":
      return fmt.dateTime(String(v));
    case "Boolean":
      return fmt.t(v === true ? "common.yes" : "common.no");
    case "Number":
      return fmt.number(Number(v));
    case "Person":
      return fmt.t("objects.person");
    default:
      return String(v);
  }
}

/**
 * Records of a custom object (Section 4.6.3): list, board (by its first Choice field), table and
 * calendar (by its first date field) views, only those the object's fields support; a create drawer
 * from the object's typed fields; and a record peek with the record's activity, comments and files,
 * that explains why the viewer can see the record.
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
  // The object is resolved before anything streams, so a missing object answers 404; the records
  // load behind a skeleton.
  return (
    <Suspense fallback={<PageSkeleton rows={6} />}>
      <ObjectRecords ctx={ctx} object={type.data} query={await searchParams} />
    </Suspense>
  );
}

async function ObjectRecords({
  ctx,
  object,
  query,
}: {
  ctx: OrgContext;
  object: ObjectType;
  query: Readonly<Record<string, string | string[] | undefined>>;
}) {
  const fmt = await getFormatters(ctx);
  const { t } = fmt;
  const board = boardField(object);
  const calendar = calendarField(object);
  const views: ViewKind[] = [
    "list",
    ...(board ? (["board"] as const) : []),
    "table",
    ...(calendar ? (["calendar"] as const) : []),
  ];
  const preferred = object.defaultView.toLowerCase() as ViewKind;
  const state = collectionState(
    query["view"] ? query : { ...query, view: views.includes(preferred) ? preferred : "list" },
    views,
    await orgToday(ctx),
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
  let conversation: Conversation | null = null;
  let activity: HistoryItem[] | null = null;
  if (peeked) {
    const [explained, collab, history, t] = await Promise.all([
      explainAccess(ctx.viewer.db, "custom_object_records", peeked.id),
      loadConversation(ctx, { table: "app.custom_object_records", id: peeked.id }),
      getFieldHistory(ctx.viewer.db, "app.custom_object_records", peeked.id),
      getTranslate(),
    ]);
    paths = explained.ok ? explained.data : null;
    conversation = collab;
    // Its fields' changes are the record's (1750): each value is keyed values.{field key}.
    const byKey = new Map(object.fields.map((f) => [`values.${f.key}`, f]));
    activity = history.ok
      ? historyItems(history.data, {
          t,
          when: fmt.dateTime,
          label: (field) =>
            field === "title"
              ? fmt.t("objects.titleColumn")
              : field === "deleted_at"
                ? t("collab.history.trash")
                : (byKey.get(field)?.label ?? null),
          value: (field, v) =>
            field === "deleted_at"
              ? fmt.dateTime(String(v))
              : historyValue(byKey.get(field), v, fmt),
        })
      : null;
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
      {peeked && conversation ? (
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
          activity={activity}
          conversation={conversation}
          me={ctx.viewer.person?.id ?? null}
        />
      ) : null}
    </CollectionView>
  );
}
