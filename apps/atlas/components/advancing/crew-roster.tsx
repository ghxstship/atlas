import {
  listProjectRoster,
  ROSTER_ENTRY_STATES,
  type RosterEntry,
  type RosterEntryState,
} from "@xos/data/roster";
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

const VIEWS = ["list", "table"] as const;

const key = (v: string) => v.toLowerCase();

/**
 * The crew roster in Atlas (R4, ADR 0101): every party's people on the project's engagements, from
 * app.roster_entry_people, grouped by party. A reviewer (advancing.submission.review) accepts or returns
 * each submitted entry, one by one or in bulk with one reason through app.bulk_update_roster_entries;
 * the peek shows the person's shared profile, read and logged when it opens. The list follows changes
 * live (engagement_roster_entries, filtered to the org).
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
          }))}
        />
      ) : (
        groupByParty(rows).map(({ party, rows: partyRows }) => (
          <section key={party} aria-label={party} className="flex flex-col gap-4">
            <h2 className="m-0 text-label-14 font-semibold">{party}</h2>
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
          </PeekPanel>
        ) : null,
      )}
      <LiveRefresh
        topics={[{ table: "engagement_roster_entries", filter: `org_id=eq.${ctx.org.id}` }]}
      />
    </div>
  );
}
