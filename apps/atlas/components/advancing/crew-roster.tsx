import {
  listProjectRoster,
  listRosterLocks,
  ROSTER_ENTRY_STATES,
  rosterLocked,
  type RosterEntry,
  type RosterEntryState,
} from "@xos/data/roster";
import {
  listRosterFactStatus,
  rosterFactChip,
  type RosterFactChip,
  type RosterFactStatus,
} from "@xos/data/roster-facts";
import Link from "next/link";
import type { Route } from "next";
import dynamic from "next/dynamic";
import { notFound } from "next/navigation";
import { getFormatter } from "next-intl/server";
import { LiveRefresh } from "@/components/live/live-refresh";
import {
  crewBulkConfig,
  groupByParty,
  ROSTER_RECORD_STATE,
  visibleRosterRows,
} from "@/lib/advancing/crew-roster";
import { collectionPeek } from "@/components/shell/collection-peek";
import { getTranslate } from "@/lib/shell/translate";
import type { AdvancingContext } from "./context";
import { RosterReviewActions } from "./roster-forms";
import { isRowId, pickView, withQuery, type Search } from "./shared";
import { PageHeader, StateChip, Tag } from "./ui";
import { PeekPanel, PeekTable, SelectFilter, ViewSwitcher } from "./views";

// The profile reads the person's work details, logged per read, so it loads only when a peek opens.
const RosterProfilePeek = dynamic(() =>
  import("./roster-profile-peek").then((m) => m.RosterProfilePeek),
);
// Project facts (R5) are read and logged the same way, when the peek opens.
const RosterProjectFactsPeek = dynamic(() =>
  import("./roster-project-facts").then((m) => m.RosterProjectFactsPeek),
);
// Training on an agency's roster entry (R12) is read when the peek opens.
const RosterTrainingPeek = dynamic(() =>
  import("./roster-training-peek").then((m) => m.RosterTrainingPeek),
);
// The names lock dialog (R5, G-142) loads with its first open, so the page carries none of its code.
const RosterLockDialog = dynamic(() =>
  import("./roster-lock-dialog").then((m) => m.RosterLockDialog),
);

const FACT_KINDS = ["travel", "uniform", "vehicle"] as const;
const CHIP_STATE: Record<RosterFactChip, "complete" | "proposed" | "deferred"> = {
  onFile: "complete",
  missing: "proposed",
  notOffered: "deferred",
};

/** A lock instant as a datetime-local value on the project's calendar. */
function localIn(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
    .format(new Date(iso))
    .replace(" ", "T");
}

const VIEWS = ["list", "table"] as const;

const key = (v: string) => v.toLowerCase();

/**
 * The crew roster in Atlas (R4, ADR 0101): every party's people on the project's engagements, from
 * app.roster_entry_people, grouped by party. A reviewer (advancing.submission.review) accepts or returns
 * each submitted entry, one by one or in bulk with one reason through app.bulk_update_roster_entries;
 * the peek shows the person's shared profile, read and logged when it opens. The list follows changes
 * live (engagement_roster_entries, filtered to the org).
 *
 * R5 adds Travel, Uniform and Vehicle chips per entry from app.roster_project_fact_status (presence only, so the list
 * reads no value and logs nothing), the project facts in the peek (read and logged when it opens), and each party's
 * names lock in its header with Set names lock for writers.
 */
export async function CrewRoster({
  actx,
  path,
  search,
  title,
}: {
  actx: AdvancingContext;
  path: string;
  search: Search;
  title: string;
}) {
  const { ctx, can, project } = actx;
  const t = await getTranslate();
  const format = await getFormatter();
  const stateFilter = ROSTER_ENTRY_STATES.find((s) => s === search["filter"]);
  const roster = await listProjectRoster(ctx.viewer.db, {
    orgId: ctx.org.id,
    ...(project ? { projectId: project.id } : {}),
  });
  if (!roster.ok) throw new Error(`Cannot list the roster: ${JSON.stringify(roster.error)}`);
  const rows = visibleRosterRows(roster.data, stateFilter);
  const engagementIds = [...new Set(roster.data.map((e) => e.engagementId))];
  const [locks, statuses] = await Promise.all([
    listRosterLocks(ctx.viewer.db, engagementIds),
    Promise.all(engagementIds.map((id) => listRosterFactStatus(ctx.viewer.db, id))),
  ]);
  if (!locks.ok) throw new Error(`Cannot read the names locks: ${JSON.stringify(locks.error)}`);
  const statusOf = new Map<string, RosterFactStatus>();
  for (const result of statuses) {
    if (!result.ok) throw new Error(`Cannot read fact status: ${JSON.stringify(result.error)}`);
    for (const status of result.data) statusOf.set(status.rosterEntryId, status);
  }
  const chipLabel = (e: RosterEntry, kind: (typeof FACT_KINDS)[number]) => {
    const status = statusOf.get(e.id);
    return status ? t(`advancing.crew.factChips.${rosterFactChip(status, kind)}`) : "";
  };
  const lockLabel = (engagementId: string) => {
    const lock = locks.data[engagementId];
    if (!lock?.locksAt) return t("advancing.crew.lock.none");
    const date = format.dateTime(new Date(lock.locksAt), {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: lock.timeZone,
    });
    return rosterLocked(lock.locksAt)
      ? t("advancing.crew.lock.lockedOn", { date })
      : t("advancing.crew.lock.locksOn", { date });
  };
  const view = pickView(search, VIEWS, "list");
  const stateLabel = (s: RosterEntryState) => t(`advancing.crew.states.${key(s)}`);
  const responseLabel = (e: RosterEntry) => t(`advancing.crew.responses.${key(e.personResponse)}`);
  const name = (e: RosterEntry) =>
    e.fullName ?? (e.invitedEmail ? t("advancing.crew.invited", { email: e.invitedEmail }) : "");
  const arrival = (e: RosterEntry) =>
    e.arrivalStartsAt && e.arrivalEndsAt && e.arrivalTimeZone
      ? format.dateTimeRange(new Date(e.arrivalStartsAt), new Date(e.arrivalEndsAt), {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: e.arrivalTimeZone,
        })
      : t("advancing.crew.noArrival");
  const shared = (e: RosterEntry) => t("advancing.crew.shared", { n: e.shareCategories.length });
  const peekId = search["peek"];
  const peek = peekId ? roster.data.find((e) => e.id === peekId) : undefined;
  if (peekId && isRowId(peekId) && !peek) notFound();

  return (
    <div className="flex flex-col gap-12 min-w-0">
      <PageHeader
        title={title}
        count={rows.length}
        views={<ViewSwitcher views={VIEWS} current={view} />}
      />
      <p className="m-0 text-text-13 text-text-secondary">{t("advancing.crew.sentence")}</p>
      <SelectFilter
        id="crew-state"
        label={t("advancing.crew.columns.state")}
        param="filter"
        value={stateFilter ?? ""}
        options={[
          { value: "", label: t("advancing.common.allStates") },
          ...ROSTER_ENTRY_STATES.map((s) => ({ value: s, label: stateLabel(s) })),
        ]}
      />
      {rows.length === 0 ? (
        <p className="m-0 rounded-card border border-border-subtle p-16 text-text-13 text-text-secondary">
          {t("advancing.crew.empty")}
        </p>
      ) : view === "table" ? (
        <PeekTable
          caption={title}
          full={false}
          columns={[
            { key: "person", label: t("advancing.crew.columns.person") },
            { key: "party", label: t("advancing.crew.columns.party") },
            { key: "role", label: t("advancing.crew.columns.role") },
            { key: "arrival", label: t("advancing.crew.columns.arrival") },
            { key: "state", label: t("advancing.crew.columns.state") },
            { key: "response", label: t("advancing.crew.columns.response") },
            { key: "shared", label: t("advancing.crew.columns.shared") },
            ...FACT_KINDS.map((k) => ({ key: k, label: t(`advancing.crew.factColumns.${k}`) })),
          ]}
          // Each row goes through the single review: a submitted entry, never by its creator or submitter.
          bulk={crewBulkConfig(ctx.org.slug, can.review, {
            state: t("advancing.crew.columns.state"),
            accept: t("advancing.crew.accept"),
            return: t("advancing.crew.return"),
          })}
          rows={rows.map((e) => ({
            id: e.id,
            label: name(e),
            person: name(e),
            party: e.partyName ?? "",
            role: e.jobTitle ?? "",
            arrival: arrival(e),
            state: stateLabel(e.entryState),
            response: responseLabel(e),
            shared: shared(e),
            travel: chipLabel(e, "travel"),
            uniform: chipLabel(e, "uniform"),
            vehicle: chipLabel(e, "vehicle"),
          }))}
        />
      ) : (
        groupByParty(rows).map(({ party, rows: partyRows }) => (
          <section key={party} aria-label={party} className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-8">
              <h2 className="m-0 text-label-14 font-semibold">{party}</h2>
              {[...new Set(partyRows.map((e) => e.engagementId))].map((engagementId) => (
                <span key={engagementId} className="flex flex-wrap items-center gap-4">
                  <span className="text-text-12 text-text-secondary">
                    {lockLabel(engagementId)}
                  </span>
                  {can.write ? (
                    <RosterLockDialog
                      org={ctx.org.slug}
                      engagementId={engagementId}
                      party={party}
                      locksAtLocal={localIn(
                        locks.data[engagementId]?.locksAt ?? null,
                        locks.data[engagementId]?.timeZone ?? "UTC",
                      )}
                      timeZone={locks.data[engagementId]?.timeZone ?? "UTC"}
                    />
                  ) : null}
                </span>
              ))}
            </div>
            <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0">
              {partyRows.map((e) => (
                <li
                  key={e.id}
                  className="flex flex-wrap items-center justify-between gap-8 px-16 py-8"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-8">
                    <StateChip
                      state={ROSTER_RECORD_STATE[e.entryState]}
                      label={stateLabel(e.entryState)}
                      compact
                    />
                    <Link
                      href={withQuery(path, search, { peek: e.id }) as Route}
                      className="text-text-14 text-text-primary hover:underline"
                    >
                      {name(e)}
                    </Link>
                    <span className="text-text-12 text-text-secondary">
                      {[e.jobTitle, arrival(e), responseLabel(e), shared(e)]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                    {e.isSelf ? <Tag tone="neutral">{t("advancing.crew.self")}</Tag> : null}
                    {statusOf.has(e.id)
                      ? FACT_KINDS.map((k) => {
                          const status = statusOf.get(e.id);
                          if (!status) return null;
                          const chip = rosterFactChip(status, k);
                          return (
                            <StateChip
                              key={k}
                              compact
                              state={CHIP_STATE[chip]}
                              label={`${t(`advancing.crew.factColumns.${k}`)}: ${t(`advancing.crew.factChips.${chip}`)}`}
                            />
                          );
                        })
                      : null}
                  </div>
                  {can.review && e.entryState === "Submitted" ? (
                    <RosterReviewActions org={ctx.org.slug} id={e.id} name={name(e)} />
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      {collectionPeek(
        peekId,
        peek ? (
          <PeekPanel
            full={false}
            title={name(peek)}
            state={ROSTER_RECORD_STATE[peek.entryState]}
            stateLabel={stateLabel(peek.entryState)}
            properties={[
              { label: t("advancing.crew.columns.party"), value: peek.partyName ?? "" },
              { label: t("advancing.crew.columns.role"), value: peek.jobTitle ?? "" },
              { label: t("advancing.crew.columns.arrival"), value: arrival(peek) },
              { label: t("advancing.crew.columns.response"), value: responseLabel(peek) },
              { label: t("advancing.crew.columns.shared"), value: shared(peek) },
            ]}
          >
            {can.review && peek.entryState === "Submitted" ? (
              <RosterReviewActions org={ctx.org.slug} id={peek.id} name={name(peek)} />
            ) : null}
            {peek.personId ? <RosterProfilePeek org={ctx.org.slug} id={peek.id} /> : null}
            {peek.personId && peek.roleType === "Staff" && !peek.isSelf ? (
              <RosterTrainingPeek db={ctx.viewer.db} org={ctx.org.slug} id={peek.id} />
            ) : null}
            {peek.personId && statusOf.has(peek.id) ? (
              <RosterProjectFactsPeek
                org={ctx.org.slug}
                id={peek.id}
                party={peek.partyName ?? ""}
              />
            ) : null}
          </PeekPanel>
        ) : null,
      )}
      <LiveRefresh
        topics={[{ table: "engagement_roster_entries", filter: `org_id=eq.${ctx.org.id}` }]}
      />
    </div>
  );
}
