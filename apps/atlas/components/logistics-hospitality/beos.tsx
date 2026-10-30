import {
  getBeo,
  listBeos,
  listFulfillments,
  type Beo,
  type BeoDetail,
} from "@xos/data/hospitality";
import { findIdByKey, instantToLocal } from "@xos/data/logistics";
import type { RecordState } from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import dynamic from "next/dynamic";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import {
  addBeoLineAction,
  approveBeoAction,
  createBeoAction,
  deleteBeoAction,
  removeBeoLineAction,
  restoreBeoAction,
  updateBeoAction,
} from "@/app/[org]/hospitality/actions";
import { ButtonLink, EmptyStateLink } from "@/components/ui";

// Roster counts (R7) load with the record that shows them, and read only when asked for (each read is logged).
const BeoRosterCounts = dynamic(() => import("./roster-counts").then((m) => m.BeoRosterCounts));
import { nodeHref } from "@/lib/shell/sitemap";
import { OperationsCalendar, OperationsList, OperationsTable, ViewSwitcher } from "./client";
import { ActionButton, FormDrawer, InlineForm, type FieldSpec } from "./forms";
import { currencyOptions } from "./fulfillments";
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
import { InlineAlert, PageHeader, RefusalNotice, TemplateCollection } from "./ui";
import { DocumentActions } from "@/components/documents/document-actions";

/**
 * Hospitality > BEOs (Section 4.5.5; journey 21): banquet event orders generated from catering
 * fulfillments, with menu and service lines, confirmed by approval. Approval needs
 * hospitality.beo.approve and is never by the BEO's author (separation of duties).
 */

export const BEO_VIEWS = ["list", "table", "calendar"] as const;
type BeoView = (typeof BEO_VIEWS)[number];

const beoState = (b: Beo): RecordState => (b.approvedAt ? "complete" : "proposed");

export async function BeosSection({
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
  const view = readView<BeoView>(search, BEO_VIEWS, "list");
  const filter = {
    orgId: scope.ctx.org.id,
    ...(scope.project ? { projectId: scope.project.id } : {}),
  };
  const [rows, catering] = await Promise.all([
    listBeos(db, filter),
    listFulfillments(db, { ...filter, kind: "Catering" }),
  ]);
  if (!rows.ok) throw new Error(`Cannot read BEOs: ${JSON.stringify(rows.error)}`);
  if (!catering.ok) throw new Error(`Cannot read catering: ${JSON.stringify(catering.error)}`);
  const writable = writableProjects(scope, "hospitality.beo.write");
  const listHref = hrefWith(base, search, { peek: null, full: null, edit: null, create: null });
  const peekHref = (key: string) => hrefWith(base, search, { peek: key, full: null, edit: null });
  const titleOf = (b: Beo) =>
    b.fulfillmentTitle
      ? t("beos.titleFor", { fulfillment: b.fulfillmentTitle })
      : t("beos.titleStandalone");
  const stateLabel = (b: Beo) => (b.approvedAt ? t("beos.state.approved") : t("beos.state.draft"));

  const fieldsFor = (b?: BeoDetail): FieldSpec[] => {
    const projectId =
      b?.projectId ?? param(search, "project") ?? scope.project?.id ?? writable[0]?.id ?? "";
    const project = writable.find((p) => p.id === projectId) ?? writable[0];
    const tz = b?.timeZone ?? project?.timeZone ?? "UTC";
    return [
      ...(b
        ? []
        : [
            {
              name: "projectId",
              label: t("beos.fields.project"),
              kind: "select" as const,
              required: true,
              defaultValue: project?.id ?? "",
              options: writable.map((p) => ({ value: p.id, label: `${p.key} ${p.name}` })),
            },
          ]),
      {
        name: "fulfillmentId",
        label: t("beos.fields.fulfillment"),
        kind: "select",
        defaultValue: b?.fulfillmentId ?? param(search, "fulfillment") ?? "",
        options: [
          { value: "", label: t("beos.fields.noFulfillment") },
          ...catering.data
            .filter((f) => !project || f.projectId === project.id)
            .map((f) => ({ value: f.id, label: `${f.key} ${f.title}` })),
        ],
      },
      {
        name: "eventAt",
        label: t("beos.fields.eventAt"),
        kind: "datetime",
        required: true,
        help: tc("timeZoneHelp", { zone: tz }),
        defaultValue: b ? instantToLocal(b.eventAt, b.timeZone) : "",
      },
      {
        name: "guestCount",
        label: t("beos.fields.guestCount"),
        kind: "number",
        defaultValue: b?.guestCount === null || b === undefined ? "" : String(b.guestCount),
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
          reason={tc("refusal.createReason", { thing: t("beos.title") })}
        />
      ) : (
        <FormDrawer
          title={t("beos.new")}
          fields={fieldsFor()}
          hidden={{ org: scope.ctx.org.slug }}
          action={createBeoAction}
          submitLabel={t("beos.new")}
          closeHref={listHref}
          successHref={hrefWith(base, search, {
            create: null,
            project: null,
            fulfillment: null,
            peek: "{key}",
          })}
        />
      );
  }

  const peekKey = param(search, "peek");
  let record: ReactNode = null;
  if (peekKey) {
    const id = await findIdByKey(db, scope.ctx.org.id, "beos", peekKey);
    const detail = id.ok ? await getBeo(db, id.data) : id;
    if (!detail.ok && detail.error.kind !== "not-found") {
      throw new Error(`Cannot read BEO: ${JSON.stringify(detail.error)}`);
    }
    if (detail.ok) {
      const b = detail.data;
      const full = param(search, "full") === "1";
      const org = scope.ctx.org.slug;
      const canWrite = scope.access.can(b.projectId, "hospitality.beo.write");
      const canApprove = scope.access.can(b.projectId, "hospitality.beo.approve");
      const isAuthor = b.createdBy !== null && b.createdBy === scope.ctx.viewer.person?.id;
      const fulfillmentsHref = nodeHref("hospitality.fulfillments", scope.params);
      const fulfillmentKey = catering.data.find((f) => f.id === b.fulfillmentId)?.key;
      const currencies = await currencyOptions(scope);
      record = (
        <>
          <RecordView
            mode={full ? "full" : "peek"}
            kindLabel={t("kinds.beo")}
            recordKey={b.key}
            title={titleOf(b)}
            state={beoState(b)}
            stateLabel={stateLabel(b)}
            propertiesLabel={tc("properties")}
            backHref={listHref}
            backLabel={tc("backToList", { section: t("beos.title") })}
            properties={[
              { label: t("beos.fields.project"), value: b.projectKey },
              {
                label: t("beos.fields.fulfillment"),
                value:
                  fulfillmentKey && fulfillmentsHref ? (
                    <Link
                      href={`${fulfillmentsHref}?peek=${fulfillmentKey}` as Route}
                      className="text-accent-text"
                    >
                      {fulfillmentKey} {b.fulfillmentTitle}
                    </Link>
                  ) : (
                    (b.fulfillmentTitle ?? t("beos.fields.noFulfillment"))
                  ),
              },
              { label: t("beos.fields.eventAt"), value: format.dateTime(b.eventAt, b.timeZone) },
              { label: t("beos.fields.guestCount"), value: b.guestCount ?? tc("notSet") },
              ...(b.fulfillmentId
                ? [
                    {
                      label: t("beos.rosterCounts.title"),
                      value: <BeoRosterCounts org={org} fulfillmentId={b.fulfillmentId} />,
                    },
                  ]
                : []),
              {
                label: t("beos.fields.approval"),
                value: b.approvedAt
                  ? b.approvedByName
                    ? t("beos.approved", {
                        time: format.dateTime(b.approvedAt, b.timeZone) ?? "",
                        name: b.approvedByName,
                      })
                    : t("beos.approvedNoName", {
                        time: format.dateTime(b.approvedAt, b.timeZone) ?? "",
                      })
                  : t("beos.notApproved"),
              },
              {
                label: t("beos.fields.total"),
                value: <TotalValue db={scope.ctx.viewer.db} total={b.total} />,
              },
            ]}
            actions={
              <>
                {!b.approvedAt && canApprove && !isAuthor ? (
                  <ActionButton
                    label={t("beos.approve")}
                    variant="primary"
                    run={approveBeoAction.bind(null, org, b.id)}
                  />
                ) : null}
                {canWrite && !b.approvedAt ? (
                  <>
                    <ButtonLink href={hrefWith(base, search, { edit: "1" })} size="sm">
                      {tc("edit")}
                    </ButtonLink>
                    <ActionButton
                      label={tc("delete")}
                      variant="ghost"
                      run={deleteBeoAction.bind(null, org, b.id)}
                      doneHref={listHref}
                      undo={{
                        message: tc("deleted", { key: b.key }),
                        restore: restoreBeoAction.bind(null, org, b.id),
                      }}
                    />
                  </>
                ) : null}
                <DocumentActions org={org} kind="beo" id={b.id} />
              </>
            }
          >
            {!b.approvedAt && canApprove && isAuthor ? (
              <InlineAlert tone="info">{t("beos.authorHint")}</InlineAlert>
            ) : null}
            <Section id={`beo-lines-${b.id}`} title={t("beos.lines.title")}>
              {b.lines.length === 0 ? (
                <p className="m-0 text-text-13 text-text-secondary">
                  {canWrite ? t("beos.lines.empty") : t("beos.lines.emptyReadOnly")}
                </p>
              ) : (
                <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
                  {b.lines.map((line) => (
                    <li
                      key={line.id}
                      className="flex flex-wrap items-center justify-between gap-8 py-8"
                    >
                      <span className="text-text-14">
                        <span className="tabular-nums">{line.quantity}</span> {line.description}
                      </span>
                      <span className="flex items-center gap-8">
                        <Amount
                          db={scope.ctx.viewer.db}
                          minor={line.amountMinor}
                          currency={line.currencyCode}
                        />
                        {canWrite && !b.approvedAt ? (
                          <ActionButton
                            label={t("beos.lines.remove", { description: line.description })}
                            variant="ghost"
                            run={removeBeoLineAction.bind(null, org, line.id)}
                          />
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {canWrite && !b.approvedAt ? (
                <InlineForm
                  label={t("beos.lines.add")}
                  hidden={{ org, beoId: b.id }}
                  action={addBeoLineAction}
                  submitLabel={t("beos.lines.add")}
                  fields={[
                    {
                      name: "description",
                      label: t("beos.lines.description"),
                      kind: "text",
                      required: true,
                    },
                    {
                      name: "quantity",
                      label: t("beos.lines.quantity"),
                      kind: "number",
                      defaultValue: "1",
                    },
                    {
                      name: "unitPrice",
                      label: t("beos.lines.unitPrice"),
                      kind: "money",
                      help: t("fulfillments.lines.unitPriceHelp"),
                    },
                    {
                      name: "currencyCode",
                      label: t("beos.lines.currency"),
                      kind: "select",
                      defaultValue: "USD",
                      options: currencies,
                    },
                  ]}
                />
              ) : null}
            </Section>
            <RecordCollab
              scope={scope}
              subject={{ table: "app.beos", id: b.id }}
              canPost={canWrite || canApprove}
            />
          </RecordView>
          {param(search, "edit") === "1" && canWrite && !b.approvedAt ? (
            <FormDrawer
              title={t("beos.editTitle", { key: b.key })}
              fields={fieldsFor(b)}
              hidden={{ org, id: b.id }}
              action={updateBeoAction}
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
      title={t("beos.title")}
      count={rows.data.length}
      views={
        <ViewSwitcher
          label={tc("views.label")}
          current={view}
          options={BEO_VIEWS.map((v) => ({ value: v, label: tc(`views.${v}`) }))}
        />
      }
      actions={
        writable.length > 0 ? (
          <ButtonLink href={createHref} variant="primary">
            {t("beos.new")}
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
          icon="UtensilsCrossed"
          sentence={t("beos.empty")}
          actionLabel={t("beos.emptyAction")}
          href={createHref}
        />
      ) : (
        <EmptyStateLink
          icon="UtensilsCrossed"
          sentence={t("beos.emptyReadOnly")}
          actionLabel={t("fulfillments.title")}
          href={nodeHref("hospitality.fulfillments", scope.params) ?? "/"}
        />
      );
  } else if (view === "table") {
    body = (
      <OperationsTable
        caption={t("beos.title")}
        columns={[
          { key: "key", label: t("beos.fields.key"), type: "code", width: 110 },
          { key: "title", label: t("beos.fields.fulfillment"), wrap: true },
          { key: "eventAt", label: t("beos.fields.eventAt") },
          { key: "guests", label: t("beos.fields.guestCount"), type: "number", width: 120 },
          { key: "state", label: t("beos.fields.state") },
          { key: "total", label: t("beos.fields.total") },
        ]}
        rows={rows.data.map((b) => ({
          key: b.key,
          title: titleOf(b),
          eventAt: format.dateTime(b.eventAt, b.timeZone) ?? "",
          guests: b.guestCount ?? "",
          state: stateLabel(b),
          total: b.total.mixedCurrencies
            ? tc("mixedCurrencies")
            : (format.money(
                b.total.amountMinor,
                b.total.currencyCode,
                exponents.get(b.total.currencyCode ?? "") ?? 2,
              ) ?? tc("unpriced")),
          id: b.id,
          label: b.key,
          href: peekHref(b.key),
          fullHref: hrefWith(base, search, { peek: b.key, full: "1", edit: null }),
          ...(!b.approvedAt && scope.access.can(b.projectId, "hospitality.beo.write")
            ? { trashMessage: tc("deleted", { key: b.key }) }
            : {}),
        }))}
        bulk={
          writableProjects(scope, "hospitality.beo.approve").length > 0
            ? {
                org: scope.ctx.org.slug,
                resource: "beos",
                // Approval is stamped once: the database refuses the author and any undo.
                fields: [
                  {
                    key: "approved_at",
                    label: t("beos.bulk.approval"),
                    options: [{ value: true, label: t("beos.state.approved") }],
                  },
                ],
              }
            : null
        }
        trash={{
          org: scope.ctx.org.slug,
          label: tc("delete"),
          run: deleteBeoAction,
          restore: restoreBeoAction,
        }}
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
        items={rows.data.map((b) => ({
          date: isoDateIn(b.eventAt, b.timeZone),
          label: `${b.key} ${titleOf(b)}`,
          state: beoState(b),
          href: peekHref(b.key),
        }))}
      />
    );
  } else {
    body = (
      <OperationsList
        label={t("beos.title")}
        openLabel={tc("open")}
        items={rows.data.map((b) => ({
          key: b.key,
          href: peekHref(b.key),
          state: beoState(b),
          stateLabel: stateLabel(b),
          title: titleOf(b),
          chips: [stateLabel(b), ...(scope.project ? [] : [b.projectKey])],
          next: format.dateTime(b.eventAt, b.timeZone) ?? "",
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
