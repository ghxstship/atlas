import { doorTotals, listDoorGuests, type DoorGuest } from "@xos/data/workforce-site";
import { personNames } from "@xos/data/person-names";
import { getFormatter } from "next-intl/server";
import { CollectionView } from "@/components/collection-kit/collection-view";
import {
  ActionButton,
  EmptyRefresh,
  ErrorPanel,
  PeekDrawer,
} from "@/components/collection-kit/kit";
import type { KitRow, KitState, ViewKind } from "@/components/collection-kit/types";
import { PageHeader, StatTile } from "@/components/collection-kit/ui";
import { EmptyStateLink } from "@/components/ui";
import { checkInGuestAction } from "@/lib/workforce/actions";
import type { Copy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import { nodeHref } from "@/lib/shell/sitemap";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import { ProjectPicker, REFUSALS, chosenProject, orgPickers, workforceCopy } from "./shared";
import { CollectionPage } from "@/components/platform/collection-page";

const VIEWS: readonly ViewKind[] = ["table", "list"];

function guestState(g: DoorGuest, t: Copy): KitState {
  return g.state === "Checked In"
    ? { state: "complete", label: t("guests.checkedIn") }
    : { state: "ready", label: t("guests.expected") };
}

/**
 * Site Operations > Guest Check-In (Section 4.9 guest list check-in at doors): the project's approved
 * guests for door staff, searchable by name, checked in with their plus-ones and an optional credential
 * scan. Guests are approved on the Advancing guest list; the door never adds anyone. B8 (2974): each guest's pass
 * type, table and host, and a search by the exact pass code a guest shows.
 */
export async function GuestCheckInSection({
  ctx,
  path,
  search,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
}) {
  const state = collectionState(search, VIEWS, await orgToday(ctx));
  const [t, format, pickers] = await Promise.all([
    workforceCopy(),
    getFormatter(),
    orgPickers(ctx),
  ]);
  const title = t("guests.title");
  const project = chosenProject(pickers.projects, search);
  if (project === null) {
    return (
      <CollectionPage header={<PageHeader title={title} />}>
        <EmptyStateLink
          icon="FolderPlus"
          sentence={t("site.noProjects")}
          actionLabel={t("site.openProjects")}
          href={nodeHref("projects.all", { org: ctx.org.slug }) ?? "/"}
        />
      </CollectionPage>
    );
  }
  const rawQuery = search["q"];
  const query = (Array.isArray(rawQuery) ? rawQuery[0] : rawQuery)?.trim() ?? "";
  const guests = await listDoorGuests(ctx.viewer.db, project.id, query === "" ? null : query);
  const picker = <ProjectPicker t={t} path={path} projects={pickers.projects} current={project} />;
  if (!guests.ok) {
    return (
      <CollectionPage header={<PageHeader title={title} />}>
        {picker}
        {guests.error.kind === "not-found" ? (
          <EmptyRefresh icon="Lock" sentence={t("guests.noAccess")} />
        ) : (
          <ErrorPanel what={t("guests.what")} />
        )}
      </CollectionPage>
    );
  }
  const scoped = {
    ...state,
    baseQuery: new URLSearchParams({
      ...Object.fromEntries(new URLSearchParams(state.baseQuery)),
      project: project.id,
    }).toString(),
  };
  const totals = doorTotals(guests.data);
  const hosts = await personNames(
    ctx.viewer.db,
    guests.data.map((g) => g.hostPersonId),
  );
  const passType = (g: DoorGuest) =>
    g.passCategoryName ? `${g.passCategoryCode ?? ""} · ${g.passCategoryName}` : null;
  const selected = state.peek ? guests.data.find((g) => g.entryId === state.peek) : undefined;
  const when = (d: string) => format.dateTime(new Date(d), { timeStyle: "short" });

  const drawer = selected ? (
    <PeekDrawer
      recordKey={project.key}
      title={selected.name}
      state={guestState(selected, t)}
      closeHref={withQuery(path, scoped)}
      fullHref={withQuery(path, scoped, { peek: selected.entryId })}
      properties={[
        { label: t("guests.plusOnes"), value: String(selected.plusOnes) },
        { label: t("guests.note"), value: selected.note ?? t("guests.noNote") },
        ...(passType(selected)
          ? [{ label: t("guests.passType"), value: passType(selected) as string }]
          : []),
        ...(selected.tableLabel ? [{ label: t("guests.table"), value: selected.tableLabel }] : []),
        ...(selected.hostPersonId
          ? [{ label: t("guests.host"), value: hosts.get(selected.hostPersonId) ?? t("someone") }]
          : []),
        ...(selected.passCode ? [{ label: t("guests.passCode"), value: selected.passCode }] : []),
        {
          label: t("guests.checkedInAt"),
          value: selected.checkedInAt ? when(selected.checkedInAt) : t("guests.notYet"),
        },
      ]}
      actions={
        selected.state === "Approved" ? (
          <ActionButton
            action={checkInGuestAction}
            hidden={{ org: ctx.org.slug, id: selected.entryId }}
            label={t("guests.checkIn")}
            variant="primary"
            confirm={{
              title: t("guests.checkInTitle", { name: selected.name }),
              body: t("guests.checkInBody", { plusOnes: selected.plusOnes }),
            }}
            extraFields={[
              {
                kind: "number",
                name: "plusOnes",
                label: t("guests.plusOnesAdmitted"),
                defaultValue: String(selected.plusOnes),
                help: t("guests.plusOnesHelp", { max: selected.plusOnes }),
              },
              { kind: "text", name: "door", label: t("guests.door") },
              {
                kind: "text",
                name: "credential",
                label: t("guests.credential"),
                help: t("guests.credentialHelp"),
              },
            ]}
            refusals={REFUSALS}
          />
        ) : null
      }
    >
      {selected.state === "Checked In" ? (
        <p className="m-0 text-text-13">
          {t("guests.admittedLine", {
            plusOnes: selected.plusOnesAdmitted ?? 0,
            door: selected.door ?? t("guests.noDoor"),
          })}
        </p>
      ) : null}
    </PeekDrawer>
  ) : null;

  const rows: KitRow[] = guests.data.map((g) => ({
    id: g.entryId,
    key: project.key,
    title: g.name,
    state: guestState(g, t),
    meta: t("guests.plusOnesLine", { count: g.plusOnes }),
    cells: {
      name: g.name,
      state: guestState(g, t),
      plusOnes: g.plusOnes,
      admitted: g.plusOnesAdmitted,
      time: g.checkedInAt ? when(g.checkedInAt) : null,
      note: g.note,
      passType: passType(g),
      table: g.tableLabel,
      host: g.hostPersonId ? (hosts.get(g.hostPersonId) ?? t("someone")) : null,
    },
  }));
  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "name", label: t("guests.name"), wrap: true },
        { key: "state", label: t("feed.state"), type: "state" },
        { key: "plusOnes", label: t("guests.plusOnes"), type: "number" },
        { key: "admitted", label: t("guests.plusOnesAdmitted"), type: "number" },
        { key: "time", label: t("guests.checkedInAt") },
        { key: "passType", label: t("guests.passType") },
        { key: "table", label: t("guests.table") },
        { key: "host", label: t("guests.host") },
        { key: "note", label: t("guests.note") },
      ]}
      rows={rows}
      filters={
        <div className="flex flex-wrap items-end gap-16">
          {picker}
          <form method="get" action={path} className="flex flex-wrap items-end gap-8" role="search">
            <input type="hidden" name="project" value={project.id} />
            <div className="flex flex-col gap-4">
              <label htmlFor="door-search" className="text-label-13 font-medium">
                {t("guests.search")}
              </label>
              <input
                id="door-search"
                name="q"
                type="search"
                defaultValue={query}
                maxLength={200}
                className="h-control-md max-w-full rounded-control border border-border-control bg-bg-surface px-8 text-text-13"
              />
            </div>
            <button
              type="submit"
              className="h-control-md rounded-control border border-border-control bg-bg-surface px-12 text-text-13 font-medium"
            >
              {t("site.show")}
            </button>
          </form>
          <StatTile
            label={t("guests.checkedInCount", { expected: totals.expected })}
            value={totals.checkedIn}
          />
          <StatTile label={t("guests.peopleIn")} value={totals.people} />
        </div>
      }
      empty={
        <EmptyStateLink
          icon="Ticket"
          sentence={t("guests.empty")}
          actionLabel={t("guests.emptyAction")}
          href={`/${ctx.org.slug}/p/${project.key}/advancing?section=guests`}
        />
      }
    >
      {drawer}
    </CollectionView>
  );
}
