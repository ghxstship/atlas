import {
  formatMajorInput,
  getAccommodationBlock,
  listAccommodationBlocks,
  type AccommodationBlock,
  type AccommodationBlockDetail,
} from "@xos/data/hospitality";
import { findIdByKey, listCounterpartyOptions } from "@xos/data/logistics";
import type { RecordState } from "@xos/ui";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import {
  assignRoomAction,
  createBlockAction,
  deleteBlockAction,
  removeRoomAssignmentAction,
  restoreBlockAction,
  updateBlockAction,
} from "@/app/[org]/hospitality/actions";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import { nodeHref } from "@/lib/shell/sitemap";
import { OperationsCalendar, OperationsList, OperationsTable, ViewSwitcher } from "./client";
import { ActionButton, FormDrawer, InlineForm, type FieldSpec } from "./forms";
import { currencyOptions, guestOptions } from "./fulfillments";
import {
  calendarMonth,
  getZonedFormat,
  hrefWith,
  param,
  readView,
  RecordCollab,
  Section,
  Amount,
  getCurrencyExponents,
  TotalValue,
  writableProjects,
  type PageScope,
  type SearchParams,
} from "./kit";
import { RecordView } from "./record";
import { PageHeader, RefusalNotice, TemplateCollection } from "./ui";

/**
 * Hospitality > Accommodation blocks (Section 4.5.5): hotel room blocks with their rooms held each
 * night, release date and contracted rate, and the guests assigned rooms inside them. On any night a
 * block's assignments never exceed its rooms held (accommodation_block_full, migration 0440).
 */

export const BLOCK_VIEWS = ["list", "table", "calendar"] as const;
type BlockView = (typeof BLOCK_VIEWS)[number];

type BlockPhase = "upcoming" | "inStay" | "past";

function phaseOf(b: AccommodationBlock, today: string): BlockPhase {
  if (today < b.checkInOn) return "upcoming";
  if (today < b.checkOutOn) return "inStay";
  return "past";
}

const PHASE_STATE: Record<BlockPhase, RecordState> = {
  upcoming: "scheduled",
  inStay: "active",
  past: "complete",
};

export async function BlocksSection({
  scope,
  search,
  base,
  heading,
}: {
  scope: PageScope;
  search: SearchParams;
  base: string;
  heading?: ReactNode;
}) {
  const t = await getTranslations("hospitality");
  const tc = await getTranslations("logistics.common");
  const format = await getZonedFormat();
  const db = scope.ctx.viewer.db;
  const exponents = await getCurrencyExponents(db);
  const view = readView<BlockView>(search, BLOCK_VIEWS, "list");
  const [rows, hotels] = await Promise.all([
    listAccommodationBlocks(db, {
      orgId: scope.ctx.org.id,
      ...(scope.project ? { projectId: scope.project.id } : {}),
    }),
    listCounterpartyOptions(db, scope.ctx.org.id),
  ]);
  if (!rows.ok) throw new Error(`Cannot read blocks: ${JSON.stringify(rows.error)}`);
  if (!hotels.ok) throw new Error(`Cannot read hotels: ${JSON.stringify(hotels.error)}`);
  const writable = writableProjects(scope, "hospitality.accommodation.write");
  const today = new Date().toISOString().slice(0, 10);
  const listHref = hrefWith(base, search, { peek: null, full: null, edit: null, create: null });
  const peekHref = (key: string) => hrefWith(base, search, { peek: key, full: null, edit: null });
  const phaseLabel = (b: AccommodationBlock) => t(`blocks.state.${phaseOf(b, today)}`);
  const occupancyLine = (b: AccommodationBlock) =>
    t("blocks.occupancy", {
      assigned: b.occupancy.roomNightsAssigned,
      held: b.occupancy.roomNightsHeld,
    });
  const currencies = await currencyOptions(scope);

  const fieldsFor = (b?: AccommodationBlockDetail): FieldSpec[] => [
    ...(b
      ? []
      : [
          {
            name: "projectId",
            label: t("blocks.fields.project"),
            kind: "select" as const,
            required: true,
            defaultValue: scope.project?.id ?? writable[0]?.id ?? "",
            options: writable.map((p) => ({ value: p.id, label: `${p.key} ${p.name}` })),
          },
        ]),
    {
      name: "title",
      label: t("blocks.fields.title"),
      kind: "text",
      required: true,
      defaultValue: b?.title ?? "",
    },
    {
      name: "hotelId",
      label: t("blocks.fields.hotel"),
      kind: "select",
      defaultValue: b?.hotelId ?? "",
      options: [
        { value: "", label: tc("none") },
        ...hotels.data.map((c) => ({ value: c.id, label: c.name ?? tc("notSet") })),
      ],
    },
    {
      name: "checkInOn",
      label: t("blocks.fields.checkInOn"),
      kind: "date",
      required: true,
      defaultValue: b?.checkInOn ?? "",
    },
    {
      name: "checkOutOn",
      label: t("blocks.fields.checkOutOn"),
      kind: "date",
      required: true,
      defaultValue: b?.checkOutOn ?? "",
    },
    {
      name: "roomsHeld",
      label: t("blocks.fields.roomsHeld"),
      kind: "number",
      required: true,
      defaultValue: b ? String(b.roomsHeld) : "1",
    },
    {
      name: "releaseOn",
      label: t("blocks.fields.releaseOn"),
      kind: "date",
      help: t("blocks.fields.releaseHelp"),
      defaultValue: b?.releaseOn ?? "",
    },
    {
      name: "nightlyRate",
      label: t("blocks.fields.nightlyRate"),
      kind: "money",
      help: t("fulfillments.lines.unitPriceHelp"),
      defaultValue: formatMajorInput(
        b?.nightlyRateMinor ?? null,
        exponents.get(b?.currencyCode ?? "") ?? 2,
      ),
    },
    {
      name: "currencyCode",
      label: t("blocks.fields.currency"),
      kind: "select",
      defaultValue: b?.currencyCode ?? "USD",
      options: currencies,
    },
  ];

  let overlay: ReactNode = null;
  if (param(search, "create") === "1") {
    overlay =
      writable.length === 0 ? (
        <RefusalNotice
          outcome="REFUSE"
          title={tc("refusal.createTitle")}
          reason={tc("refusal.createReason", { thing: t("blocks.title") })}
        />
      ) : (
        <FormDrawer
          title={t("blocks.new")}
          fields={fieldsFor()}
          hidden={{ org: scope.ctx.org.slug }}
          action={createBlockAction}
          submitLabel={t("blocks.new")}
          closeHref={listHref}
          successHref={hrefWith(base, search, { create: null, peek: "{key}" })}
        />
      );
  }

  const peekKey = param(search, "peek");
  let record: ReactNode = null;
  if (peekKey) {
    const id = await findIdByKey(db, scope.ctx.org.id, "accommodation_blocks", peekKey);
    const detail = id.ok ? await getAccommodationBlock(db, id.data) : id;
    if (!detail.ok && detail.error.kind !== "not-found") {
      throw new Error(`Cannot read block: ${JSON.stringify(detail.error)}`);
    }
    if (detail.ok) {
      const b = detail.data;
      const full = param(search, "full") === "1";
      const org = scope.ctx.org.slug;
      const canWrite = scope.access.can(b.projectId, "hospitality.accommodation.write");
      const guests = await guestOptions(scope);
      record = (
        <>
          <RecordView
            mode={full ? "full" : "peek"}
            kindLabel={t("kinds.block")}
            recordKey={b.key}
            title={b.title}
            state={PHASE_STATE[phaseOf(b, today)]}
            stateLabel={phaseLabel(b)}
            propertiesLabel={tc("properties")}
            backHref={listHref}
            backLabel={tc("backToList", { section: t("blocks.title") })}
            properties={[
              { label: t("blocks.fields.project"), value: `${b.projectKey} ${b.projectName}` },
              { label: t("blocks.fields.hotel"), value: b.hotelName ?? tc("notSet") },
              { label: t("blocks.fields.checkInOn"), value: format.date(b.checkInOn) },
              { label: t("blocks.fields.checkOutOn"), value: format.date(b.checkOutOn) },
              { label: t("blocks.fields.roomsHeld"), value: b.roomsHeld },
              {
                label: t("blocks.fields.releaseOn"),
                value: format.date(b.releaseOn) ?? tc("notSet"),
              },
              {
                label: t("blocks.fields.nightlyRate"),
                value: (
                  <Amount
                    db={scope.ctx.viewer.db}
                    minor={b.nightlyRateMinor}
                    currency={b.currencyCode}
                  />
                ),
              },
              {
                label: t("blocks.fields.contractTotal"),
                value: <TotalValue db={scope.ctx.viewer.db} total={b.contractTotal} />,
              },
              { label: t("blocks.fields.occupancy"), value: occupancyLine(b) },
            ]}
            actions={
              canWrite ? (
                <>
                  <ButtonLink href={hrefWith(base, search, { edit: "1" })} size="sm">
                    {tc("edit")}
                  </ButtonLink>
                  <ActionButton
                    label={tc("delete")}
                    variant="ghost"
                    run={deleteBlockAction.bind(null, org, b.id)}
                    doneHref={listHref}
                    undo={{
                      message: tc("deleted", { key: b.key }),
                      restore: restoreBlockAction.bind(null, org, b.id),
                    }}
                  />
                </>
              ) : null
            }
          >
            <Section id={`nights-${b.id}`} title={t("blocks.nights.title")}>
              <div
                role="region"
                aria-label={t("blocks.nights.title")}
                tabIndex={0}
                className="overflow-x-auto rounded-card border border-border-subtle"
              >
                <table className="w-full border-collapse text-text-13">
                  <caption className="sr-only">{t("blocks.nights.title")}</caption>
                  <thead>
                    <tr>
                      <th
                        scope="col"
                        className="px-12 py-6 text-start text-text-12 font-medium text-text-secondary bg-bg-surface"
                      >
                        {t("blocks.nights.night")}
                      </th>
                      <th
                        scope="col"
                        className="px-12 py-6 text-end text-text-12 font-medium text-text-secondary bg-bg-surface"
                      >
                        {t("blocks.nights.assigned")}
                      </th>
                      <th
                        scope="col"
                        className="px-12 py-6 text-end text-text-12 font-medium text-text-secondary bg-bg-surface"
                      >
                        {t("blocks.nights.free")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.occupancy.byNight.map((n) => (
                      <tr key={n.night} className="border-t border-border-subtle">
                        <th scope="row" className="px-12 py-6 text-start font-normal">
                          {format.weekday(n.night)} {format.date(n.night)}
                        </th>
                        <td className="px-12 py-6 text-end tabular-nums">{n.assigned}</td>
                        <td className="px-12 py-6 text-end tabular-nums">
                          {b.roomsHeld - n.assigned}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
            <Section id={`assignments-${b.id}`} title={t("blocks.assignments.title")}>
              {b.assignments.length === 0 ? (
                <p className="m-0 text-text-13 text-text-secondary">
                  {canWrite ? t("blocks.assignments.empty") : t("blocks.assignments.emptyReadOnly")}
                </p>
              ) : (
                <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
                  {b.assignments.map((a) => (
                    <li
                      key={a.id}
                      className="flex flex-wrap items-center justify-between gap-8 py-8"
                    >
                      <span className="flex flex-col gap-2">
                        <span className="text-text-14">{a.personName ?? tc("unnamed")}</span>
                        <span className="text-text-12 text-text-secondary">
                          {t("blocks.assignments.stay", {
                            from: format.date(a.checkInOn) ?? "",
                            to: format.date(a.checkOutOn) ?? "",
                          })}
                        </span>
                      </span>
                      {canWrite ? (
                        <ActionButton
                          label={t("blocks.assignments.remove", {
                            name: a.personName ?? tc("unnamed"),
                          })}
                          variant="ghost"
                          run={removeRoomAssignmentAction.bind(null, org, a.id)}
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {canWrite ? (
                <InlineForm
                  label={t("blocks.assignments.assign")}
                  hidden={{ org, blockId: b.id }}
                  action={assignRoomAction}
                  submitLabel={t("blocks.assignments.assign")}
                  fields={[
                    {
                      name: "personId",
                      label: t("blocks.assignments.guest"),
                      kind: "select",
                      required: true,
                      defaultValue: guests[0]?.value ?? "",
                      options: guests,
                    },
                    {
                      name: "checkInOn",
                      label: t("blocks.assignments.checkInOn"),
                      kind: "date",
                      required: true,
                      defaultValue: b.checkInOn,
                    },
                    {
                      name: "checkOutOn",
                      label: t("blocks.assignments.checkOutOn"),
                      kind: "date",
                      required: true,
                      defaultValue: b.checkOutOn,
                    },
                  ]}
                />
              ) : null}
            </Section>
            <RecordCollab
              scope={scope}
              subject={{ table: "app.accommodation_blocks", id: b.id }}
              canPost={canWrite}
            />
          </RecordView>
          {param(search, "edit") === "1" && canWrite ? (
            <FormDrawer
              title={t("blocks.editTitle", { key: b.key })}
              fields={fieldsFor(b)}
              hidden={{ org, id: b.id, expectedUpdatedAt: b.updatedAt }}
              action={updateBlockAction}
              submitLabel={tc("save")}
              closeHref={hrefWith(base, search, { edit: null })}
            />
          ) : null}
        </>
      );
      if (full) return record;
    } else {
      record = (
        <RefusalNotice
          outcome="NO_ANSWER"
          title={tc("peekMissing.title")}
          reason={tc("peekMissing.reason")}
        />
      );
    }
  }

  const createHref = hrefWith(base, search, { create: "1", peek: null });
  const header = (
    <PageHeader
      title={t("blocks.title")}
      count={rows.data.length}
      views={
        <ViewSwitcher
          label={tc("views.label")}
          current={view}
          options={BLOCK_VIEWS.map((v) => ({ value: v, label: tc(`views.${v}`) }))}
        />
      }
      actions={
        writable.length > 0 ? (
          <ButtonLink href={createHref} variant="primary">
            {t("blocks.new")}
          </ButtonLink>
        ) : undefined
      }
    />
  );

  let body: ReactNode;
  if (rows.data.length === 0) {
    body =
      writable.length > 0 ? (
        <EmptyStateLink
          icon="Hotel"
          sentence={t("blocks.empty")}
          actionLabel={t("blocks.emptyAction")}
          href={createHref}
        />
      ) : (
        <EmptyStateLink
          icon="Hotel"
          sentence={t("blocks.emptyReadOnly")}
          actionLabel={t("fulfillments.title")}
          href={nodeHref("hospitality.fulfillments", scope.params) ?? "/"}
        />
      );
  } else if (view === "table") {
    body = (
      <OperationsTable
        caption={t("blocks.title")}
        columns={[
          { key: "key", label: t("blocks.fields.key"), type: "code", width: 110 },
          { key: "title", label: t("blocks.fields.title"), wrap: true },
          { key: "hotel", label: t("blocks.fields.hotel") },
          { key: "checkIn", label: t("blocks.fields.checkInOn") },
          { key: "checkOut", label: t("blocks.fields.checkOutOn") },
          { key: "rooms", label: t("blocks.fields.roomsHeld"), type: "number", width: 120 },
          { key: "occupancy", label: t("blocks.fields.occupancy") },
          { key: "total", label: t("blocks.fields.contractTotal") },
        ]}
        rows={rows.data.map((b) => ({
          key: b.key,
          title: b.title,
          hotel: b.hotelName ?? "",
          checkIn: format.date(b.checkInOn) ?? "",
          checkOut: format.date(b.checkOutOn) ?? "",
          rooms: b.roomsHeld,
          occupancy: occupancyLine(b),
          total:
            format.money(
              b.contractTotal.amountMinor,
              b.contractTotal.currencyCode,
              exponents.get(b.contractTotal.currencyCode ?? "") ?? 2,
            ) ?? tc("unpriced"),
          href: peekHref(b.key),
        }))}
      />
    );
  } else if (view === "calendar") {
    const cal = calendarMonth(search);
    body = (
      <OperationsCalendar
        month={cal.month}
        today={cal.today}
        previousMonth={cal.previous}
        nextMonth={cal.next}
        previousLabel={tc("previousMonth")}
        nextLabel={tc("nextMonth")}
        items={rows.data.map((b) => ({
          date: b.checkInOn,
          label: `${b.key} ${b.title}`,
          state: PHASE_STATE[phaseOf(b, today)],
          href: peekHref(b.key),
        }))}
      />
    );
  } else {
    body = (
      <OperationsList
        label={t("blocks.title")}
        openLabel={tc("open")}
        items={rows.data.map((b) => ({
          key: b.key,
          href: peekHref(b.key),
          state: PHASE_STATE[phaseOf(b, today)],
          stateLabel: phaseLabel(b),
          title: b.title,
          chips: [occupancyLine(b), ...(scope.project ? [] : [b.projectKey])],
          next: format.date(b.checkInOn) ?? "",
        }))}
      />
    );
  }

  return (
    <TemplateCollection
      header={
        heading ? (
          <>
            {heading}
            {header}
          </>
        ) : (
          header
        )
      }
      peek={
        <>
          {record}
          {overlay}
        </>
      }
    >
      {body}
    </TemplateCollection>
  );
}
