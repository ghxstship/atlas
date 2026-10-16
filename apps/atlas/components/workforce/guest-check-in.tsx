import { doorTotals, listDoorGuests, type DoorGuest } from "@xos/data/workforce-site";
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
import { ProjectPicker, REFUSALS, chosenProject, orgPickers, workforceCopy } from "./shared";

const VIEWS: readonly ViewKind[] = ["table", "list"];

function guestState(g: DoorGuest, t: Copy): KitState {
  return g.state === "Checked In"
    ? { state: "complete", label: t("guests.checkedIn") }
    : { state: "ready", label: t("guests.expected") };
}

/**
 * Site Operations > Guest Check-In (Section 4.9 guest list check-in at doors): the project's approved
 * guests for door staff, searchable by name, checked in with their plus-ones and an optional credential
 * scan. Guests are approved on the Advancing guest list; the door never adds anyone.
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
  const state = collectionState(search, VIEWS);
  const [t, format, pickers] = await Promise.all([
    workforceCopy(),
    getFormatter(),
    orgPickers(ctx),
  ]);
  const title = t("guests.title");
  const project = chosenProject(pickers.projects, search);
  if (project === null) {
    return (
      <>
        <PageHeader title={title} />
        <EmptyStateLink
          icon="FolderPlus"
          sentence={t("site.noProjects")}
          actionLabel={t("site.openProjects")}
          href={nodeHref("projects.all", { org: ctx.org.slug }) ?? "/"}
        />
      </>
    );
  }
  const guests = await listDoorGuests(ctx.viewer.db, project.id);
  const picker = <ProjectPicker t={t} path={path} projects={pickers.projects} current={project} />;
  if (!guests.ok) {
    return (
      <>
        <PageHeader title={title} />
        {picker}
        {guests.error.kind === "not-found" ? (
          <EmptyRefresh icon="Lock" sentence={t("guests.noAccess")} />
        ) : (
          <ErrorPanel what={t("guests.what")} />
        )}
      </>
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
        { key: "note", label: t("guests.note") },
      ]}
      rows={rows}
      filters={
        <div className="flex flex-wrap items-end gap-16">
          {picker}
          <StatTile
            label={t("guests.checkedInCount", { expected: totals.expected })}
            value={totals.checkedIn}
          />
          <StatTile label={t("guests.peopleIn")} value={totals.people} />
        </div>
      }
      empty={<EmptyRefresh icon="Ticket" sentence={t("guests.empty")} />}
    >
      {drawer}
    </CollectionView>
  );
}
