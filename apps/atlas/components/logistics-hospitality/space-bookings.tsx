import { instantToLocal } from "@xos/data/logistics";
import { listSpaces } from "@xos/data/places";
import {
  conflictGroups,
  listProjectSetTimes,
  listSpaceBookings,
  setTimeWindow,
  SPACE_BOOKING_MODES,
  SPACE_BOOKING_PURPOSES,
  type SpaceBooking,
} from "@xos/data/space-bookings";
import type { RecordState } from "@xos/ui";
import { getTranslations } from "next-intl/server";
import type { ReactNode } from "react";
import {
  cancelBookingAction,
  createBookingAction,
  restoreBookingAction,
  updateBookingAction,
} from "@/app/[org]/hospitality/transfer-actions";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import { OperationsList, OperationsTable, ViewSwitcher } from "./client";
import { ActionButton, FormDrawer, type FieldSpec } from "./forms";
import {
  getZonedFormat,
  hrefWith,
  isoDateIn,
  param,
  readView,
  RecordCollab,
  Section,
  writableProjects,
  type PageScope,
  type SearchParams,
} from "./kit";
import { LaneSchedule, mondayOf, nowMs, weekDays } from "./lanes";
import { RecordView } from "./record";
import { PageHeader, RefusalNotice, TemplateCollection } from "./ui";

/**
 * Hospitality > Green rooms and dressing rooms (B5, G-32): spaces of the project's venue booked for an act or a team,
 * optionally for a set time, from app.space_booking_board. Exclusive bookings never overlap; Shared ones may, and the
 * conflicts strip groups them with the peak party against the space's capacity and flags a set that moved, all
 * computed on read. "Book from set time" fills in 90 minutes before the set and out 60 minutes after it ends, as
 * editable defaults.
 */

export const ROOM_VIEWS = ["list", "table", "resource-schedule"] as const;
type RoomView = (typeof ROOM_VIEWS)[number];

function bookingState(b: SpaceBooking, now: number): RecordState {
  if (Date.parse(b.endsAt) <= now) return "complete";
  if (b.overCapacity || b.setMoved) return "blocked";
  if (Date.parse(b.startsAt) <= now) return "active";
  return "scheduled";
}

export async function SpaceBookingsSection({
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
  const t = (await getTranslations("hospitality.rooms")) as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;
  const tc = await getTranslations("logistics.common");
  const format = await getZonedFormat();
  const db = scope.ctx.viewer.db;
  const org = scope.ctx.org.slug;
  const view = readView<RoomView>(search, ROOM_VIEWS, "list");
  const rows = await listSpaceBookings(db, {
    orgId: scope.ctx.org.id,
    ...(scope.project ? { projectId: scope.project.id } : {}),
  });
  if (!rows.ok) throw new Error(`Cannot read space bookings: ${JSON.stringify(rows.error)}`);
  const writable = writableProjects(scope, "hospitality.fulfillment.write");
  const now = nowMs();
  const listHref = hrefWith(base, search, {
    peek: null,
    full: null,
    edit: null,
    create: null,
    set: null,
  });
  const peekHref = (id: string) => hrefWith(base, search, { peek: id, full: null, edit: null });
  const zoneOf = (projectId: string) =>
    scope.projects.find((p) => p.id === projectId)?.timeZone ?? "UTC";
  const when = (b: SpaceBooking) =>
    t("window", {
      in: format.dateTime(b.startsAt, zoneOf(b.projectId)) ?? "",
      out: format.time(b.endsAt, zoneOf(b.projectId)),
    });
  const purposeLabel = (b: SpaceBooking) => t(`purpose.${b.purpose.replace(/ /g, "")}`);
  const flags = (b: SpaceBooking) => [
    ...(b.overCapacity ? [t("flags.overCapacity")] : []),
    ...(b.setMoved ? [t("flags.setMoved")] : []),
    ...(b.mode === "Shared" ? [t("mode.Shared")] : []),
  ];
  const titleOf = (b: SpaceBooking) =>
    `${b.spaceName ?? tc("notSet")} · ${b.actName ?? purposeLabel(b)}`;

  const bookingFields = async (
    projectId: string | undefined,
    b?: SpaceBooking,
  ): Promise<FieldSpec[]> => {
    const project = scope.projects.find((p) => p.id === projectId);
    const zone = project?.timeZone ?? "UTC";
    const [spaces, sets] = await Promise.all([
      project?.venueId
        ? listSpaces(db, { orgId: scope.ctx.org.id, venueId: project.venueId })
        : null,
      projectId ? listProjectSetTimes(db, projectId) : null,
    ]);
    const chosenSet = sets?.ok ? sets.data.find((s) => s.id === param(search, "set")) : undefined;
    const fromSet = chosenSet
      ? setTimeWindow(chosenSet.plannedAt, chosenSet.durationMinutes)
      : null;
    return [
      {
        name: "spaceId",
        label: t("fields.space"),
        kind: "select",
        required: true,
        defaultValue: b?.spaceId ?? "",
        options: spaces?.ok
          ? spaces.data.map((s) => ({
              value: s.id,
              label: s.capacity ? t("spaceOption", { name: s.name, capacity: s.capacity }) : s.name,
            }))
          : [],
      },
      {
        name: "purpose",
        label: t("fields.purpose"),
        kind: "select",
        required: true,
        defaultValue: b?.purpose ?? (chosenSet ? "Dressing Room" : "Green Room"),
        options: SPACE_BOOKING_PURPOSES.map((p) => ({
          value: p,
          label: t(`purpose.${p.replace(/ /g, "")}`),
        })),
      },
      {
        name: "mode",
        label: t("fields.mode"),
        kind: "select",
        required: true,
        help: t("fields.modeHelp"),
        defaultValue: b?.mode ?? "Exclusive",
        options: SPACE_BOOKING_MODES.map((m) => ({ value: m, label: t(`mode.${m}`) })),
      },
      {
        name: "engagementCueId",
        label: t("fields.setTime"),
        kind: "select",
        defaultValue: b?.engagementCueId ?? chosenSet?.id ?? "",
        options: [
          { value: "", label: tc("none") },
          ...(sets?.ok
            ? sets.data.map((s) => ({
                value: s.id,
                label: s.plannedAt
                  ? t("setOption", { label: s.label, at: format.dateTime(s.plannedAt, zone) ?? "" })
                  : s.label,
              }))
            : []),
        ],
      },
      {
        name: "startsAt",
        label: t("fields.in"),
        kind: "datetime",
        required: true,
        help: tc("timeZoneHelp", { zone }),
        defaultValue: b
          ? instantToLocal(b.startsAt, zone)
          : fromSet
            ? instantToLocal(fromSet.startsAt, zone)
            : "",
      },
      {
        name: "endsAt",
        label: t("fields.out"),
        kind: "datetime",
        required: true,
        defaultValue: b
          ? instantToLocal(b.endsAt, zone)
          : fromSet
            ? instantToLocal(fromSet.endsAt, zone)
            : "",
      },
      {
        name: "partySize",
        label: t("fields.partySize"),
        kind: "number",
        defaultValue: b?.partySize ? String(b.partySize) : "",
      },
      { name: "notes", label: t("fields.notes"), kind: "textarea", defaultValue: b?.notes ?? "" },
    ];
  };

  let overlay: ReactNode = null;
  const projectId = scope.project?.id ?? writable[0]?.id;
  if (param(search, "create") === "1") {
    overlay =
      writable.length === 0 || !projectId ? (
        <RefusalNotice
          outcome="REFUSE"
          title={tc("refusal.createTitle")}
          reason={tc("refusal.createReason", { thing: t("title") })}
        />
      ) : (
        <FormDrawer
          title={param(search, "set") ? t("fromSet") : t("new")}
          fields={await bookingFields(projectId)}
          hidden={{ org, projectId }}
          action={createBookingAction}
          submitLabel={t("new")}
          closeHref={listHref}
          successHref={listHref}
        />
      );
  }

  const peekId = param(search, "peek");
  let record: ReactNode = null;
  if (peekId) {
    const b = rows.data.find((r) => r.id === peekId);
    if (b) {
      const canWrite = scope.access.can(b.projectId, "hospitality.fulfillment.write");
      const zone = zoneOf(b.projectId);
      record = (
        <>
          <RecordView
            mode={param(search, "full") === "1" ? "full" : "peek"}
            kindLabel={t("kind")}
            recordKey=""
            title={titleOf(b)}
            state={bookingState(b, now)}
            stateLabel={purposeLabel(b)}
            propertiesLabel={tc("properties")}
            backHref={listHref}
            backLabel={tc("backToList", { section: t("title") })}
            properties={[
              { label: t("fields.space"), value: b.spaceName ?? tc("notSet") },
              { label: t("fields.when"), value: when(b) },
              { label: t("fields.mode"), value: t(`mode.${b.mode}`) },
              { label: t("fields.partySize"), value: b.partySize ?? tc("notSet") },
              {
                label: t("fields.setTime"),
                value: b.setLabel
                  ? t("setOption", {
                      label: b.setLabel,
                      at: format.dateTime(b.setPlannedAt, zone) ?? t("notPlanned"),
                    })
                  : tc("notSet"),
              },
              { label: t("fields.flags"), value: flags(b).join(", ") || t("flags.none") },
            ]}
            actions={
              canWrite ? (
                <>
                  <ButtonLink href={hrefWith(base, search, { edit: "1" })} size="sm">
                    {tc("edit")}
                  </ButtonLink>
                  <ActionButton
                    label={t("cancel")}
                    variant="ghost"
                    run={cancelBookingAction.bind(null, org, b.id)}
                    doneHref={listHref}
                    undo={{
                      message: t("canceled"),
                      restore: restoreBookingAction.bind(null, org, b.id),
                    }}
                  />
                </>
              ) : null
            }
          >
            <RecordCollab
              scope={scope}
              subject={{ table: "app.space_bookings", id: b.id }}
              canPost={canWrite}
            />
          </RecordView>
          {param(search, "edit") === "1" && canWrite ? (
            <FormDrawer
              title={t("editTitle")}
              fields={await bookingFields(b.projectId, b)}
              hidden={{ org, id: b.id, projectId: b.projectId }}
              action={updateBookingAction}
              submitLabel={tc("save")}
              closeHref={hrefWith(base, search, { edit: null })}
            />
          ) : null}
        </>
      );
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

  // Book from set time: the project's planned sets, each opening the form with its in and out filled in.
  const sets = projectId && writable.length > 0 ? await listProjectSetTimes(db, projectId) : null;
  const planned = sets?.ok ? sets.data.filter((s) => s.plannedAt !== null) : [];

  const header = (
    <PageHeader
      title={t("title")}
      count={rows.data.length}
      views={
        <ViewSwitcher
          label={tc("views.label")}
          current={view}
          options={ROOM_VIEWS.map((v) => ({
            value: v,
            label: tc(`views.${v === "resource-schedule" ? "resourceSchedule" : v}`),
          }))}
        />
      }
      actions={
        writable.length > 0 ? (
          <ButtonLink
            href={hrefWith(base, search, { create: "1", peek: null, set: null })}
            variant="primary"
          >
            {t("new")}
          </ButtonLink>
        ) : undefined
      }
    />
  );

  const groups = conflictGroups(rows.data);
  const strip =
    groups.length > 0 ? (
      <Section id="room-conflicts" title={t("conflicts.title", { count: groups.length })}>
        <ul className="m-0 flex list-none flex-col gap-8 p-0">
          {groups.map((g) => {
            const first = g[0] as SpaceBooking;
            return (
              <li key={first.id} className="flex flex-col gap-2 text-text-13">
                <span className="font-medium">
                  {t("conflicts.group", {
                    space: first.spaceName ?? tc("notSet"),
                    count: g.length,
                    peak: first.groupPeakParty,
                  })}
                  {first.overCapacity ? ` · ${t("flags.overCapacity")}` : ""}
                </span>
                <span className="text-text-12 text-text-secondary">
                  {g.map((b) => `${b.actName ?? purposeLabel(b)} (${when(b)})`).join("; ")}
                </span>
              </li>
            );
          })}
        </ul>
      </Section>
    ) : null;
  const fromSetList =
    planned.length > 0 ? (
      <Section id="book-from-set" title={t("fromSet")}>
        <ul className="m-0 flex list-none flex-wrap gap-8 p-0">
          {planned.map((s) => (
            <li key={s.id}>
              <ButtonLink
                href={hrefWith(base, search, { create: "1", set: s.id, peek: null })}
                size="sm"
                variant="ghost"
              >
                {t("setOption", {
                  label: s.label,
                  at:
                    format.dateTime(
                      s.plannedAt,
                      scope.projects.find((p) => p.id === projectId)?.timeZone ?? "UTC",
                    ) ?? "",
                })}
              </ButtonLink>
            </li>
          ))}
        </ul>
      </Section>
    ) : null;

  let body: ReactNode;
  if (rows.data.length === 0) {
    body = (
      <EmptyStateLink
        icon="Users"
        sentence={writable.length > 0 ? t("empty") : t("emptyReadOnly")}
        actionLabel={t("new")}
        href={hrefWith(base, search, { create: "1" })}
      />
    );
  } else if (view === "table") {
    body = (
      <OperationsTable
        caption={t("title")}
        columns={[
          { key: "space", label: t("fields.space") },
          { key: "act", label: t("fields.act"), wrap: true },
          { key: "purpose", label: t("fields.purpose") },
          { key: "when", label: t("fields.when"), wrap: true },
          { key: "set", label: t("fields.setTime"), wrap: true },
          { key: "party", label: t("fields.partySize"), type: "number", width: 100 },
          { key: "flags", label: t("fields.flags"), wrap: true },
        ]}
        rows={rows.data.map((b) => ({
          id: b.id,
          label: titleOf(b),
          space: b.spaceName ?? "",
          act: b.actName ?? "",
          purpose: purposeLabel(b),
          when: when(b),
          set: b.setLabel ?? "",
          party: b.partySize ?? "",
          flags: flags(b).join(", "),
          href: peekHref(b.id),
          ...(scope.access.can(b.projectId, "hospitality.fulfillment.write")
            ? { trashMessage: t("canceled") }
            : {}),
        }))}
        trash={{ org, label: t("cancel"), run: cancelBookingAction, restore: restoreBookingAction }}
      />
    );
  } else if (view === "resource-schedule") {
    const monday = mondayOf(param(search, "week") ?? scope.today);
    const days = weekDays(monday);
    const spaces = new Map<string, { label: string; detail?: string; items: SpaceBooking[] }>();
    for (const b of rows.data) {
      const lane = spaces.get(b.spaceId) ?? {
        label: b.spaceName ?? tc("notSet"),
        ...(b.spaceCapacity ? { detail: t("capacity", { capacity: b.spaceCapacity }) } : {}),
        items: [],
      };
      lane.items.push(b);
      spaces.set(b.spaceId, lane);
    }
    body = (
      <LaneSchedule
        caption={t("lanesCaption", { date: format.date(monday) ?? "" })}
        laneHeading={t("fields.space")}
        days={days}
        dayLabel={(d) => ({ weekday: format.weekday(d), date: format.date(d) ?? "" })}
        lanes={[...spaces.entries()].map(([id, lane]) => ({
          id,
          label: lane.label,
          ...(lane.detail ? { detail: lane.detail } : {}),
          items: lane.items.map((b) => ({
            id: b.id,
            day: isoDateIn(b.startsAt, zoneOf(b.projectId)),
            label: `${format.time(b.startsAt, zoneOf(b.projectId))} ${b.actName ?? purposeLabel(b)}`,
            state: bookingState(b, now),
            href: peekHref(b.id),
          })),
        }))}
      />
    );
  } else {
    body = (
      <OperationsList
        label={t("title")}
        openLabel={tc("open")}
        items={rows.data.map((b) => ({
          key: b.id,
          href: peekHref(b.id),
          state: bookingState(b, now),
          stateLabel: purposeLabel(b),
          title: titleOf(b),
          chips: flags(b),
          next: when(b),
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
      <div className="flex flex-col gap-16">
        {strip}
        {fromSetList}
        {body}
      </div>
    </TemplateCollection>
  );
}
