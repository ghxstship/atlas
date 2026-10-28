import {
  getFulfillment,
  listCurrencies,
  listFulfillmentMoves,
  listFulfillments,
  listFulfillmentTransitions,
  listTravelSegments,
  FULFILLMENT_KINDS,
  FULFILLMENT_STATES,
  type Fulfillment,
  type FulfillmentDetail,
  type FulfillmentState,
} from "@xos/data/hospitality";
import { findIdByKey, instantToLocal, listCounterpartyOptions } from "@xos/data/logistics";
import type { RecordState } from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import {
  addFulfillmentLineAction,
  cancelTravelAction,
  createFulfillmentAction,
  createTravelAction,
  deleteFulfillmentAction,
  removeFulfillmentLineAction,
  restoreFulfillmentAction,
  transitionFulfillmentAction,
  updateFulfillmentAction,
} from "@/app/[org]/hospitality/actions";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import { projectPeople, projectPeopleNames, projectPersonLabel } from "@/lib/people/project-people";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate } from "@/lib/shell/translate";
import {
  OperationsBoard,
  OperationsCalendar,
  OperationsList,
  OperationsTable,
  ViewSwitcher,
} from "./client";
import { ActionButton, FormDrawer, InlineForm, TransitionForm, type FieldSpec } from "./forms";
import {
  calendarMonth,
  getZonedFormat,
  hrefWith,
  isoDateIn,
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
 * Hospitality > Fulfillments (Section 4.5.5; journey 21): lodging, catering, travel and amenity
 * fulfillments on the fulfillment lifecycle, with lines priced or unpriced, BEOs for catering and
 * travel segments for travel. Views: list, table, board by state and calendar.
 */

export const FULFILLMENT_VIEWS = ["list", "table", "board", "calendar"] as const;
type FulfillmentView = (typeof FULFILLMENT_VIEWS)[number];

export const FULFILLMENT_RECORD_STATE: Record<FulfillmentState, RecordState> = {
  Proposed: "proposed",
  Active: "active",
  Blocked: "blocked",
  Complete: "complete",
  Canceled: "canceled",
};

/**
 * Guest choices on a project: the org's members and the people engaged on the project (R1), engaged
 * non-members labelled with the account that supplies them.
 */
export async function guestOptions(scope: PageScope, projectId: string) {
  const [tc, t] = await Promise.all([getTranslations("logistics.common"), getTranslate()]);
  return (await projectPeople(scope.ctx, projectId))
    .map((p) => ({ value: p.personId, label: projectPersonLabel(t, p, tc("unnamed")) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Names of a project's members and engaged people by person id, for guest and traveller names. */
export async function guestNames(scope: PageScope, projectId: string) {
  return projectPeopleNames(await projectPeople(scope.ctx, projectId));
}

export async function currencyOptions(scope: PageScope) {
  const currencies = await listCurrencies(scope.ctx.viewer.db);
  if (!currencies.ok) {
    throw new Error(`Cannot read currencies: ${JSON.stringify(currencies.error)}`);
  }
  return currencies.data.map((c) => ({ value: c.code, label: c.code }));
}

export async function FulfillmentsSection({
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
  const view = readView<FulfillmentView>(search, FULFILLMENT_VIEWS, "list");
  const [rows, suppliers] = await Promise.all([
    listFulfillments(db, {
      orgId: scope.ctx.org.id,
      ...(scope.project ? { projectId: scope.project.id } : {}),
    }),
    listCounterpartyOptions(db, scope.ctx.org.id),
  ]);
  if (!rows.ok) throw new Error(`Cannot read fulfillments: ${JSON.stringify(rows.error)}`);
  if (!suppliers.ok) throw new Error(`Cannot read suppliers: ${JSON.stringify(suppliers.error)}`);
  const writable = writableProjects(scope, "hospitality.fulfillment.write");
  const listHref = hrefWith(base, search, { peek: null, full: null, edit: null, create: null });
  const peekHref = (key: string) => hrefWith(base, search, { peek: key, full: null, edit: null });
  const stateLabel = (s: FulfillmentState) => t(`fulfillments.state.${s}`);

  const fieldsFor = (f?: FulfillmentDetail): FieldSpec[] => {
    const zone = f?.timeZone ?? scope.project?.timeZone ?? writable[0]?.timeZone ?? "UTC";
    return [
      ...(f
        ? []
        : [
            {
              name: "projectId",
              label: t("fulfillments.fields.project"),
              kind: "select" as const,
              required: true,
              defaultValue: scope.project?.id ?? writable[0]?.id ?? "",
              options: writable.map((p) => ({ value: p.id, label: `${p.key} ${p.name}` })),
            },
          ]),
      {
        name: "kind",
        label: t("fulfillments.fields.kind"),
        kind: "select",
        required: true,
        defaultValue: f?.kind ?? param(search, "kind") ?? "Lodging",
        options: FULFILLMENT_KINDS.map((k) => ({ value: k, label: t(`fulfillments.kind.${k}`) })),
      },
      {
        name: "title",
        label: t("fulfillments.fields.title"),
        kind: "text",
        required: true,
        help: t("fulfillments.fields.titleHelp"),
        defaultValue: f?.title ?? "",
      },
      {
        name: "supplierId",
        label: t("fulfillments.fields.supplier"),
        kind: "select",
        help: t("fulfillments.fields.supplierHelp"),
        defaultValue: f?.supplierId ?? "",
        options: [
          { value: "", label: tc("none") },
          ...suppliers.data.map((c) => ({ value: c.id, label: c.name ?? tc("notSet") })),
        ],
      },
      {
        name: "startsAt",
        label: t("fulfillments.fields.startsAt"),
        kind: "datetime",
        help: tc("timeZoneHelp", { zone }),
        defaultValue: f?.startsAt ? instantToLocal(f.startsAt, f.timeZone) : "",
      },
      {
        name: "endsAt",
        label: t("fulfillments.fields.endsAt"),
        kind: "datetime",
        defaultValue: f?.endsAt ? instantToLocal(f.endsAt, f.timeZone) : "",
      },
    ];
  };

  let overlay: ReactNode = null;
  if (param(search, "create") === "1") {
    overlay =
      writable.length === 0 ? (
        <RefusalNotice
          outcome="REFUSE"
          title={tc("refusal.createTitle")}
          reason={tc("refusal.createReason", { thing: t("fulfillments.title") })}
        />
      ) : (
        <FormDrawer
          title={t("fulfillments.new")}
          fields={fieldsFor()}
          hidden={{ org: scope.ctx.org.slug }}
          action={createFulfillmentAction}
          submitLabel={t("fulfillments.new")}
          closeHref={listHref}
          successHref={hrefWith(base, search, { create: null, kind: null, peek: "{key}" })}
        />
      );
  }

  const peekKey = param(search, "peek");
  let record: ReactNode = null;
  if (peekKey) {
    const id = await findIdByKey(db, scope.ctx.org.id, "fulfillments", peekKey);
    const detail = id.ok ? await getFulfillment(db, id.data) : id;
    if (!detail.ok && detail.error.kind !== "not-found") {
      throw new Error(`Cannot read fulfillment: ${JSON.stringify(detail.error)}`);
    }
    if (detail.ok) {
      const f = detail.data;
      const full = param(search, "full") === "1";
      const canWrite = scope.access.can(f.projectId, "hospitality.fulfillment.write");
      record = (
        <>
          <FulfillmentRecord
            scope={scope}
            fulfillment={f}
            mode={full ? "full" : "peek"}
            backHref={listHref}
            editHref={hrefWith(base, search, { edit: "1" })}
          />
          {param(search, "edit") === "1" && canWrite ? (
            <FormDrawer
              title={t("fulfillments.editTitle", { key: f.key })}
              fields={fieldsFor(f)}
              hidden={{ org: scope.ctx.org.slug, id: f.id, expectedUpdatedAt: f.updatedAt }}
              action={updateFulfillmentAction}
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
      title={t("fulfillments.title")}
      count={rows.data.length}
      views={
        <ViewSwitcher
          label={tc("views.label")}
          current={view}
          options={FULFILLMENT_VIEWS.map((v) => ({ value: v, label: tc(`views.${v}`) }))}
        />
      }
      actions={
        writable.length > 0 ? (
          <ButtonLink href={createHref} variant="primary">
            {t("fulfillments.new")}
          </ButtonLink>
        ) : undefined
      }
    />
  );

  const chips = (f: Fulfillment) => [
    t(`fulfillments.kind.${f.kind}`),
    ...(scope.project ? [] : [f.projectKey]),
    ...(f.guestCount > 0 ? [t("fulfillments.guestCount", { count: f.guestCount })] : []),
  ];

  let body: ReactNode;
  if (rows.data.length === 0) {
    body =
      scope.projects.length === 0 ? (
        <EmptyStateLink
          icon="FolderPlus"
          sentence={t("fulfillments.noProjects")}
          actionLabel={t("fulfillments.noProjectsAction")}
          href={nodeHref("projects.all", scope.params) ?? "/"}
        />
      ) : writable.length > 0 ? (
        <EmptyStateLink
          icon="ConciergeBell"
          sentence={t("fulfillments.empty")}
          actionLabel={t("fulfillments.emptyAction")}
          href={createHref}
        />
      ) : (
        <EmptyStateLink
          icon="ConciergeBell"
          sentence={t("fulfillments.emptyReadOnly")}
          actionLabel={t("blocks.title")}
          href={nodeHref("hospitality.accommodation-blocks", scope.params) ?? "/"}
        />
      );
  } else if (view === "table") {
    body = (
      <OperationsTable
        caption={t("fulfillments.title")}
        columns={[
          { key: "key", label: t("fulfillments.fields.key"), type: "code", width: 110 },
          { key: "title", label: t("fulfillments.fields.title"), wrap: true },
          { key: "kind", label: t("fulfillments.fields.kind") },
          { key: "state", label: t("fulfillments.fields.state") },
          { key: "supplier", label: t("fulfillments.fields.supplier") },
          { key: "starts", label: t("fulfillments.fields.startsAt") },
          { key: "guests", label: t("fulfillments.fields.guests"), type: "number", width: 90 },
          { key: "total", label: t("fulfillments.fields.total") },
        ]}
        rows={rows.data.map((f) => ({
          key: f.key,
          title: f.title,
          kind: t(`fulfillments.kind.${f.kind}`),
          state: stateLabel(f.state),
          supplier: f.supplierName ?? "",
          starts: format.dateTime(f.startsAt, f.timeZone) ?? "",
          guests: f.guestCount,
          total: f.total.mixedCurrencies
            ? tc("mixedCurrencies")
            : (format.money(
                f.total.amountMinor,
                f.total.currencyCode,
                exponents.get(f.total.currencyCode ?? "") ?? 2,
              ) ?? tc("unpriced")),
          id: f.id,
          label: f.key,
          href: peekHref(f.key),
          fullHref: hrefWith(base, search, { peek: f.key, full: "1", edit: null }),
          ...(scope.access.can(f.projectId, "hospitality.fulfillment.write")
            ? { trashMessage: tc("deleted", { key: f.key }) }
            : {}),
        }))}
        bulk={
          writable.length > 0
            ? {
                org: scope.ctx.org.slug,
                resource: "fulfillments",
                fields: [
                  {
                    key: "fulfillment_state",
                    label: t("fulfillments.fields.state"),
                    reason: true,
                    // Proposed is where a fulfillment starts; no move returns to it.
                    options: FULFILLMENT_STATES.filter((st) => st !== "Proposed").map((st) => ({
                      value: st,
                      label: stateLabel(st),
                    })),
                  },
                  {
                    key: "counterparty_id",
                    label: t("fulfillments.fields.supplier"),
                    options: [
                      { value: null, label: tc("none") },
                      ...suppliers.data.map((c) => ({
                        value: c.id,
                        label: c.name ?? tc("notSet"),
                      })),
                    ],
                  },
                ],
              }
            : null
        }
        trash={{
          org: scope.ctx.org.slug,
          label: tc("delete"),
          run: deleteFulfillmentAction,
          restore: restoreFulfillmentAction,
        }}
      />
    );
  } else if (view === "board") {
    body = (
      <OperationsBoard
        columns={FULFILLMENT_STATES.map((s) => ({
          state: FULFILLMENT_RECORD_STATE[s],
          label: stateLabel(s),
          cards: rows.data
            .filter((f) => f.state === s)
            .map((f) => ({
              key: f.key,
              title: f.title,
              meta: `${f.key} ${t(`fulfillments.kind.${f.kind}`)}`,
              href: peekHref(f.key),
            })),
        }))}
      />
    );
  } else if (view === "calendar") {
    const cal = calendarMonth(search, scope.today);
    body = (
      <OperationsCalendar
        month={cal.month}
        today={cal.today}
        previousMonth={cal.previous}
        nextMonth={cal.next}
        previousLabel={tc("previousMonth")}
        nextLabel={tc("nextMonth")}
        items={rows.data.flatMap((f) =>
          f.startsAt
            ? [
                {
                  date: isoDateIn(f.startsAt, f.timeZone),
                  label: `${f.key} ${f.title}`,
                  state: FULFILLMENT_RECORD_STATE[f.state],
                  href: peekHref(f.key),
                },
              ]
            : [],
        )}
      />
    );
  } else {
    body = (
      <OperationsList
        label={t("fulfillments.title")}
        openLabel={tc("open")}
        items={rows.data.map((f) => ({
          key: f.key,
          href: peekHref(f.key),
          state: FULFILLMENT_RECORD_STATE[f.state],
          stateLabel: stateLabel(f.state),
          title: f.title,
          chips: chips(f),
          ...(f.startsAt ? { next: format.dateTime(f.startsAt, f.timeZone) ?? "" } : {}),
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

async function FulfillmentRecord({
  scope,
  fulfillment: f,
  mode,
  backHref,
  editHref,
}: {
  scope: PageScope;
  fulfillment: FulfillmentDetail;
  mode: "peek" | "full";
  backHref: string;
  editHref: string;
}) {
  const t = await getTranslations("hospitality");
  const tc = await getTranslations("logistics.common");
  const format = await getZonedFormat();
  const db = scope.ctx.viewer.db;
  const org = scope.ctx.org.slug;
  const canWrite = scope.access.can(f.projectId, "hospitality.fulfillment.write");
  const canBeo = scope.access.can(f.projectId, "hospitality.beo.write");
  const [moves, history, travel, guests, currencies] = await Promise.all([
    listFulfillmentMoves(db, f.state),
    listFulfillmentTransitions(db, f.id),
    f.kind === "Travel" ? listTravelSegments(db, { orgId: "", fulfillmentId: f.id }) : null,
    guestOptions(scope, f.projectId),
    currencyOptions(scope),
  ]);
  const names = await guestNames(scope, f.projectId);
  if (!moves.ok) throw new Error(`Cannot read moves: ${JSON.stringify(moves.error)}`);
  if (!history.ok) throw new Error(`Cannot read history: ${JSON.stringify(history.error)}`);
  if (travel && !travel.ok) throw new Error(`Cannot read travel: ${JSON.stringify(travel.error)}`);
  const beosHref = nodeHref("hospitality.beos", scope.params);
  const closed = f.state === "Complete" || f.state === "Canceled";
  const stateLabel = (s: FulfillmentState) => t(`fulfillments.state.${s}`);

  return (
    <RecordView
      mode={mode}
      kindLabel={t(`fulfillments.kind.${f.kind}`)}
      recordKey={f.key}
      title={f.title}
      state={FULFILLMENT_RECORD_STATE[f.state]}
      stateLabel={stateLabel(f.state)}
      propertiesLabel={tc("properties")}
      backHref={backHref}
      backLabel={tc("backToList", { section: t("fulfillments.title") })}
      properties={[
        { label: t("fulfillments.fields.project"), value: `${f.projectKey} ${f.projectName}` },
        { label: t("fulfillments.fields.kind"), value: t(`fulfillments.kind.${f.kind}`) },
        { label: t("fulfillments.fields.supplier"), value: f.supplierName ?? tc("notSet") },
        {
          label: t("fulfillments.fields.startsAt"),
          value: format.dateTime(f.startsAt, f.timeZone) ?? tc("notSet"),
        },
        {
          label: t("fulfillments.fields.endsAt"),
          value: format.dateTime(f.endsAt, f.timeZone) ?? tc("notSet"),
        },
        {
          label: t("fulfillments.fields.guests"),
          value: t("fulfillments.guestCount", { count: f.guestCount }),
        },
        {
          label: t("fulfillments.fields.total"),
          value: <TotalValue db={scope.ctx.viewer.db} total={f.total} />,
        },
      ]}
      actions={
        canWrite ? (
          <>
            <ButtonLink href={editHref} size="sm">
              {tc("edit")}
            </ButtonLink>
            <ActionButton
              label={tc("delete")}
              variant="ghost"
              run={deleteFulfillmentAction.bind(null, org, f.id)}
              doneHref={backHref}
              undo={{
                message: tc("deleted", { key: f.key }),
                restore: restoreFulfillmentAction.bind(null, org, f.id),
              }}
            />
          </>
        ) : null
      }
    >
      {canWrite ? (
        <TransitionForm
          formLabel={t("fulfillments.transition.form")}
          label={t("fulfillments.transition.label")}
          reasonLabel={t("fulfillments.transition.reason")}
          submitLabel={t("fulfillments.transition.submit")}
          moves={moves.data.map((s) => ({ value: s, label: stateLabel(s) }))}
          run={transitionFulfillmentAction.bind(null, org, f.id, f.state)}
        />
      ) : null}

      <Section id={`lines-${f.id}`} title={t("fulfillments.lines.title")}>
        {f.lines.length === 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {canWrite ? t("fulfillments.lines.empty") : t("fulfillments.lines.emptyReadOnly")}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {f.lines.map((line) => (
              <li key={line.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
                <span className="flex flex-col gap-2">
                  <span className="text-text-14">
                    <span className="tabular-nums">{line.quantity}</span> {line.description}
                  </span>
                  <span className="text-text-12 text-text-secondary">
                    {line.personName ??
                      (line.personId ? names.get(line.personId) : undefined) ??
                      t("fulfillments.lines.noGuest")}
                  </span>
                </span>
                <span className="flex items-center gap-8">
                  <Amount
                    db={scope.ctx.viewer.db}
                    minor={line.amountMinor}
                    currency={line.currencyCode}
                  />
                  {canWrite && !closed ? (
                    <ActionButton
                      label={t("fulfillments.lines.remove", { description: line.description })}
                      variant="ghost"
                      run={removeFulfillmentLineAction.bind(null, org, line.id)}
                    />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        {canWrite && !closed ? (
          <InlineForm
            label={t("fulfillments.lines.add")}
            hidden={{ org, fulfillmentId: f.id }}
            action={addFulfillmentLineAction}
            submitLabel={t("fulfillments.lines.add")}
            fields={[
              {
                name: "description",
                label: t("fulfillments.lines.description"),
                kind: "text",
                required: true,
              },
              {
                name: "personId",
                label: t("fulfillments.lines.guest"),
                kind: "select",
                defaultValue: "",
                options: [{ value: "", label: t("fulfillments.lines.noGuest") }, ...guests],
              },
              {
                name: "quantity",
                label: t("fulfillments.lines.quantity"),
                kind: "number",
                defaultValue: "1",
              },
              {
                name: "unitPrice",
                label: t("fulfillments.lines.unitPrice"),
                kind: "money",
                help: t("fulfillments.lines.unitPriceHelp"),
              },
              {
                name: "currencyCode",
                label: t("fulfillments.lines.currency"),
                kind: "select",
                defaultValue: "USD",
                options: currencies,
              },
            ]}
          />
        ) : null}
      </Section>

      {f.kind === "Catering" ? (
        <Section
          id={`beos-${f.id}`}
          title={t("fulfillments.beos.title")}
          actions={
            canBeo && beosHref ? (
              <ButtonLink
                href={`${beosHref}?create=1&project=${f.projectId}&fulfillment=${f.id}`}
                size="sm"
              >
                {t("fulfillments.beos.generate")}
              </ButtonLink>
            ) : undefined
          }
        >
          {f.beos.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("fulfillments.beos.empty")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
              {f.beos.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
                  {beosHref ? (
                    <Link href={`${beosHref}?peek=${b.key}` as Route} className="text-accent-text">
                      {b.key} {format.dateTime(b.eventAt, b.timeZone)}
                    </Link>
                  ) : (
                    <span>{b.key}</span>
                  )}
                  <span className="text-text-12 text-text-secondary">
                    {b.approvedAt ? t("beos.state.approved") : t("beos.state.draft")}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}

      {travel?.ok ? (
        <Section id={`travel-${f.id}`} title={t("fulfillments.travel.title")}>
          {travel.data.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("fulfillments.travel.empty")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
              {travel.data.map((seg) => (
                <li key={seg.id} className="flex flex-wrap items-center justify-between gap-8 py-8">
                  <span className="flex flex-col gap-2">
                    <span className="text-text-14">
                      {t("fulfillments.travel.line", {
                        traveler: seg.personName ?? names.get(seg.personId) ?? tc("unnamed"),
                        summary: t("fulfillments.travel.summary", {
                          mode: t(`fulfillments.travel.modes.${seg.mode}`),
                          service: seg.serviceIdentifier ?? seg.operatorName ?? "",
                        }),
                      })}
                    </span>
                    <span className="text-text-12 text-text-secondary">
                      {t("fulfillments.travel.when", {
                        route: t("fulfillments.travel.route", {
                          from: seg.departsFrom,
                          to: seg.arrivesAtPlace,
                        }),
                        time: format.dateTime(seg.departsAt, seg.departsTimeZone) ?? "",
                      })}
                    </span>
                  </span>
                  <span className="flex items-center gap-8">
                    <Amount
                      db={scope.ctx.viewer.db}
                      minor={seg.priceMinor}
                      currency={seg.currencyCode}
                    />
                    {canWrite ? (
                      <ActionButton
                        label={t("fulfillments.travel.cancel")}
                        variant="ghost"
                        run={cancelTravelAction.bind(null, org, seg.id)}
                      />
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {canWrite && !closed ? (
            <InlineForm
              label={t("fulfillments.travel.add")}
              hidden={{ org, fulfillmentId: f.id }}
              action={createTravelAction}
              submitLabel={t("fulfillments.travel.add")}
              fields={[
                {
                  name: "personId",
                  label: t("fulfillments.travel.traveler"),
                  kind: "select",
                  required: true,
                  options: guests,
                  defaultValue: guests[0]?.value ?? "",
                },
                {
                  name: "mode",
                  label: t("fulfillments.travel.mode"),
                  kind: "select",
                  defaultValue: "Flight",
                  options: [
                    { value: "Flight", label: t("fulfillments.travel.modes.Flight") },
                    { value: "Ground", label: t("fulfillments.travel.modes.Ground") },
                  ],
                },
                { name: "operatorName", label: t("fulfillments.travel.operator"), kind: "text" },
                {
                  name: "serviceIdentifier",
                  label: t("fulfillments.travel.service"),
                  kind: "text",
                },
                {
                  name: "confirmationIdentifier",
                  label: t("fulfillments.travel.confirmation"),
                  kind: "text",
                },
                {
                  name: "departsFrom",
                  label: t("fulfillments.travel.departsFrom"),
                  kind: "text",
                  required: true,
                },
                {
                  name: "departsAt",
                  label: t("fulfillments.travel.departsAt"),
                  kind: "datetime",
                  required: true,
                  help: tc("timeZoneHelp", { zone: f.timeZone }),
                },
                {
                  name: "arrivesAtPlace",
                  label: t("fulfillments.travel.arrivesAtPlace"),
                  kind: "text",
                  required: true,
                },
                { name: "arrivesAt", label: t("fulfillments.travel.arrivesAt"), kind: "datetime" },
                {
                  name: "fare",
                  label: t("fulfillments.travel.fare"),
                  kind: "money",
                  help: t("fulfillments.lines.unitPriceHelp"),
                },
                {
                  name: "currencyCode",
                  label: t("fulfillments.lines.currency"),
                  kind: "select",
                  defaultValue: "USD",
                  options: currencies,
                },
              ]}
            />
          ) : null}
        </Section>
      ) : null}

      <Section id={`history-${f.id}`} title={t("fulfillments.history.title")}>
        <ol className="m-0 flex list-none flex-col gap-8 p-0">
          {history.data.map((h) => (
            <li key={h.id} className="flex flex-col gap-2 border-s border-border-subtle ps-12">
              <span className="text-text-13">
                {h.fromState === null
                  ? t("fulfillments.history.created", {
                      state: stateLabel(h.toState),
                      time: format.dateTime(h.at, f.timeZone) ?? "",
                    })
                  : t("fulfillments.history.moved", {
                      from: stateLabel(h.fromState),
                      to: stateLabel(h.toState),
                      time: format.dateTime(h.at, f.timeZone) ?? "",
                    })}
              </span>
              {h.byName ? (
                <span className="text-text-12 text-text-secondary">
                  {t("fulfillments.history.by", { name: h.byName })}
                </span>
              ) : null}
              <span className="text-text-12 text-text-secondary">{h.reason}</span>
            </li>
          ))}
        </ol>
      </Section>

      <RecordCollab
        scope={scope}
        subject={{ table: "app.fulfillments", id: f.id }}
        canPost={canWrite}
      />
    </RecordView>
  );
}
