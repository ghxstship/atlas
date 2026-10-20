import {
  checkInOpen,
  eventPhase,
  listWorkforceEvents,
  myRsvp,
  rsvpCounts,
  RSVP_RESPONSES,
  WORKFORCE_EVENT_KINDS,
  type WorkforceEvent,
} from "@xos/data/workforce-events";
import { getFormatter } from "next-intl/server";
import { CollabPanels } from "@/components/collection-kit/collab";
import { CollectionView } from "@/components/collection-kit/collection-view";
import {
  ActionButton,
  EmptyRefresh,
  EntityForm,
  ErrorPanel,
  FormDrawer,
  KitLink,
  KitSection,
  PeekDrawer,
} from "@/components/collection-kit/kit";
import type { KitRow, KitState, ViewKind } from "@/components/collection-kit/types";
import { PageHeader } from "@/components/collection-kit/ui";
import { EmptyStateLink } from "@/components/ui";
import {
  cancelEventAction,
  checkInAction,
  createEventAction,
  rsvpAction,
} from "@/lib/workforce/actions";
import type { Copy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { requestNow } from "@/lib/workforce/time";
import { REFUSALS, audienceFields, audienceLabel, orgPickers, workforceCopy } from "./shared";

const VIEWS: readonly ViewKind[] = ["list", "calendar", "table"];

function eventState(e: WorkforceEvent, t: Copy): KitState {
  const phase = eventPhase(e);
  const map = {
    canceled: "canceled",
    past: "complete",
    live: "active",
    upcoming: "scheduled",
  } as const;
  return { state: map[phase], label: t(`events.phases.${phase}`) };
}

/**
 * Schedule > Events (Section 4.9 Events): briefings, crew calls and meetings with RSVP, location,
 * agenda and check-in. Invitees answer and check in from an hour before the start; the organizer sees
 * the roster and checks people in. Creating an event invites its audience.
 */
export async function EventsSection({
  ctx,
  path,
  search,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
}) {
  const state = collectionState(search, VIEWS);
  const [t, format, events, pickers] = await Promise.all([
    workforceCopy(),
    getFormatter(),
    listWorkforceEvents(ctx.viewer.db, ctx.org.id, {
      from: new Date(requestNow() - 30 * 86_400_000).toISOString(),
    }),
    orgPickers(ctx),
  ]);
  const title = t("events.title");
  if (!events.ok) {
    return (
      <>
        <PageHeader title={title} />
        <ErrorPanel what={t("events.what")} />
      </>
    );
  }
  const canSchedule = ctx.role !== "viewer";
  const me = ctx.org.membershipId;
  const when = (d: string) =>
    format.dateTime(new Date(d), { dateStyle: "medium", timeStyle: "short" });
  const selected = state.peek ? events.data.find((e) => e.id === state.peek) : undefined;
  const createHref = withQuery(path, state, { create: "1" });

  let drawer = null;
  if (state.create && canSchedule) {
    drawer = (
      <FormDrawer title={t("events.create")} closeHref={withQuery(path, state)}>
        <EntityForm
          id="event-create"
          action={createEventAction}
          hidden={{ org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("events.create")}
          successHref={withQuery(path, state, { peek: "{id}" })}
          fields={[
            {
              kind: "select",
              name: "kind",
              label: t("events.kind"),
              required: true,
              defaultValue: "Briefing",
              options: WORKFORCE_EVENT_KINDS.map((k) => ({
                value: k,
                label: t(`events.kinds.${k}`),
              })),
            },
            { kind: "text", name: "title", label: t("events.eventTitle"), required: true },
            { kind: "datetime", name: "startsAt", label: t("events.startsAt"), required: true },
            { kind: "datetime", name: "endsAt", label: t("events.endsAt"), required: true },
            { kind: "text", name: "location", label: t("events.location") },
            { kind: "textarea", name: "agenda", label: t("events.agenda"), rows: 4 },
            ...audienceFields(t, pickers),
          ]}
        />
        <p className="m-0 text-text-12 text-text-secondary">{t("events.scheduleNote")}</p>
      </FormDrawer>
    );
  } else if (selected) {
    const counts = rsvpCounts(selected);
    const organizer = selected.organizerMembershipId === me;
    const mine = myRsvp(selected, [me]);
    const checkedIn = selected.checkIns.some((c) => c.membershipId === me);
    const open = checkInOpen(selected);
    const pending = selected.rsvps.filter(
      (r) =>
        r.response !== "Declined" &&
        !selected.checkIns.some((c) => c.membershipId === r.membershipId),
    );
    drawer = (
      <PeekDrawer
        recordKey={t(`events.kinds.${selected.kind}`)}
        title={selected.title}
        state={eventState(selected, t)}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id })}
        properties={[
          { label: t("events.startsAt"), value: when(selected.startsAt) },
          { label: t("events.endsAt"), value: when(selected.endsAt) },
          { label: t("events.location"), value: selected.location ?? t("events.noLocation") },
          { label: t("feed.audienceLabel"), value: audienceLabel(t, selected.audience, pickers) },
          { label: t("events.organizer"), value: selected.organizerName ?? t("someone") },
          {
            label: t("events.rsvps"),
            value: t("events.rsvpCounts", {
              going: counts.Going,
              maybe: counts.Maybe,
              declined: counts.Declined,
            }),
          },
        ]}
        actions={
          selected.canceledAt ? null : (
            <>
              {eventPhase(selected) !== "past"
                ? RSVP_RESPONSES.map((r) => (
                    <ActionButton
                      key={r}
                      action={rsvpAction}
                      hidden={{ org: ctx.org.slug, id: selected.id, response: r }}
                      label={t(`events.rsvp.${r}`)}
                      variant={mine === r ? "primary" : "secondary"}
                      refusals={REFUSALS}
                    />
                  ))
                : null}
              {open && !checkedIn ? (
                <ActionButton
                  action={checkInAction}
                  hidden={{ org: ctx.org.slug, id: selected.id }}
                  label={t("events.checkIn")}
                  variant="primary"
                  refusals={REFUSALS}
                />
              ) : null}
              {organizer || canSchedule ? (
                <ActionButton
                  action={cancelEventAction}
                  hidden={{ org: ctx.org.slug, id: selected.id }}
                  label={t("events.cancel")}
                  variant="danger"
                  reason={t("events.cancelReason")}
                  refusals={REFUSALS}
                />
              ) : null}
            </>
          )
        }
      >
        {selected.cancelReason ? (
          <p className="m-0 text-text-13">
            {t("events.canceledBecause", { reason: selected.cancelReason })}
          </p>
        ) : null}
        {selected.agenda ? (
          <KitSection id="event-agenda" title={t("events.agenda")}>
            <p className="m-0 whitespace-pre-wrap text-text-14">{selected.agenda}</p>
          </KitSection>
        ) : null}
        <KitSection id="event-roster" title={t("events.roster")}>
          {selected.rsvps.length === 0 && selected.checkIns.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("events.noRoster")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-8 p-0 text-text-13">
              {selected.checkIns.map((c) => (
                <li key={`c-${c.membershipId}`}>
                  {t("events.checkedInLine", { name: c.name ?? t("someone"), time: when(c.at) })}
                </li>
              ))}
              {pending.map((r) => (
                <li key={`r-${r.membershipId}`} className="flex flex-wrap items-center gap-8">
                  <span>
                    {t("events.rsvpLine", {
                      name: r.name ?? t("someone"),
                      response: t(`events.rsvp.${r.response}`),
                    })}
                  </span>
                  {organizer && open ? (
                    <ActionButton
                      action={checkInAction}
                      hidden={{ org: ctx.org.slug, id: selected.id, membershipId: r.membershipId }}
                      label={t("events.checkInPerson")}
                      refusals={REFUSALS}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </KitSection>
        <CollabPanels ctx={ctx} table="app.workforce_events" id={selected.id} />
      </PeekDrawer>
    );
  }

  const rows: KitRow[] = events.data.map((e) => ({
    id: e.id,
    key: t(`events.kinds.${e.kind}`),
    title: e.title,
    state: eventState(e, t),
    date: e.startsAt.slice(0, 10),
    meta: t("events.line", {
      time: when(e.startsAt),
      location: e.location ?? t("events.noLocation"),
    }),
    cells: {
      kind: t(`events.kinds.${e.kind}`),
      title: e.title,
      state: eventState(e, t),
      starts: when(e.startsAt),
      location: e.location,
      going: rsvpCounts(e).Going,
      mine: myRsvp(e, [me]) ? t(`events.rsvp.${myRsvp(e, [me])}`) : null,
    },
  }));
  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      month={state.month}
      columns={[
        { key: "kind", label: t("events.kind") },
        { key: "title", label: t("events.eventTitle"), wrap: true },
        { key: "state", label: t("feed.state"), type: "state" },
        { key: "starts", label: t("events.startsAt") },
        { key: "location", label: t("events.location") },
        { key: "going", label: t("events.going"), type: "number" },
        { key: "mine", label: t("events.myRsvp") },
      ]}
      rows={rows}
      actions={
        canSchedule ? (
          <KitLink href={createHref} variant="primary">
            {t("events.create")}
          </KitLink>
        ) : null
      }
      empty={
        canSchedule ? (
          <EmptyStateLink
            icon="CalendarPlus"
            sentence={t("events.empty")}
            actionLabel={t("events.create")}
            href={createHref}
          />
        ) : (
          <EmptyRefresh icon="CalendarPlus" sentence={t("events.emptyRead")} />
        )
      }
    >
      {drawer}
    </CollectionView>
  );
}
