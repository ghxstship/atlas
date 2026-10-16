import {
  GUEST_STATES,
  listGuests,
  listProjectScopes,
  type GuestEntry,
  type GuestState,
} from "@xos/data/advancing";
import type { RecordState } from "@xos/ui";
import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { getFormatter } from "next-intl/server";
import { getTranslate } from "@/lib/shell/translate";
import type { AdvancingContext } from "./context";
import { AddGuestDialog, GuestActions } from "./guest-forms";
import { RecordCollab } from "./record-collab";
import { partyLabel, pickView, withQuery, type Search } from "./shared";
import { PageHeader, StateChip, Tag } from "./ui";
import { PeekPanel, PeekTable, SelectFilter, ViewSwitcher } from "./views";

const VIEWS = ["list", "table"] as const;

const GUEST_RECORD_STATE: Readonly<Record<GuestState, RecordState>> = {
  Requested: "proposed",
  Approved: "ready",
  Declined: "canceled",
  "Checked In": "complete",
};

const stateKey = (s: GuestState) => s.replace(" ", "");

/**
 * The project's guest list (0431): Requested guests wait for a reviewer who did not request them,
 * approved guests are checked in at the door, and engaged artists add theirs from Gateway. List and
 * table views with a state filter, a peek with comments and attachments, and totals with plus-ones.
 */
export async function GuestList({
  actx,
  project,
  path,
  search,
  title,
}: {
  actx: AdvancingContext;
  project: { id: string; key: string; name: string };
  path: string;
  search: Search;
  title: string;
}) {
  const { ctx, can } = actx;
  const t = await getTranslate();
  const format = await getFormatter();
  const stateFilter = GUEST_STATES.find((s) => s === search["filter"]);
  const [guests, scopes] = await Promise.all([
    listGuests(ctx.viewer.db, {
      orgId: ctx.org.id,
      projectId: project.id,
      ...(stateFilter ? { state: stateFilter } : {}),
    }),
    listProjectScopes(ctx.viewer.db, project.id),
  ]);
  if (!guests.ok) throw new Error(`Cannot list guests: ${JSON.stringify(guests.error)}`);
  if (!scopes.ok) throw new Error(`Cannot list scopes: ${JSON.stringify(scopes.error)}`);
  const scopeOptions = scopes.data.map((s) => ({ value: s.id, label: `${s.code} · ${s.name}` }));
  const scopeName = (id: string | null) =>
    scopes.data.find((s) => s.id === id)?.name ?? t("advancing.guests.wholeProject");
  const view = pickView(search, VIEWS, "list");
  const label = (s: GuestState) => t(`advancing.guests.states.${stateKey(s)}`);
  const admitted = guests.data
    .filter((g) => g.state === "Approved" || g.state === "Checked In")
    .reduce((n, g) => n + 1 + g.plusOnes, 0);
  const from = (g: GuestEntry) =>
    g.party ? partyLabel(g.party, t) : t("advancing.guests.production");
  const peek = search["peek"] ? guests.data.find((g) => g.id === search["peek"]) : undefined;
  if (search["peek"] && !peek) notFound();
  const item = (g: GuestEntry) => ({
    id: g.id,
    guestName: g.guestName,
    plusOnes: g.plusOnes,
    note: g.note,
    scopeNodeId: g.scopeNodeId,
  });

  return (
    <div className="flex flex-col gap-12 min-w-0">
      <PageHeader
        title={title}
        count={guests.data.length}
        views={<ViewSwitcher views={VIEWS} current={view} />}
        {...(can.rider
          ? {
              actions: (
                <AddGuestDialog
                  org={ctx.org.slug}
                  projectId={project.id}
                  scopes={scopeOptions}
                  canApprove={can.review}
                />
              ),
            }
          : {})}
      />
      <div className="flex flex-wrap items-end gap-8">
        <SelectFilter
          id="guests-state"
          label={t("advancing.common.state")}
          param="filter"
          value={stateFilter ?? ""}
          options={[
            { value: "", label: t("advancing.common.allStates") },
            ...GUEST_STATES.map((s) => ({ value: s, label: label(s) })),
          ]}
        />
        <p className="m-0 pb-8 text-text-13 text-text-secondary" role="status">
          {t("advancing.guests.admitted", { count: admitted })}
        </p>
      </div>
      {guests.data.length === 0 ? (
        <p className="m-0 rounded-card border border-border-subtle p-16 text-text-13 text-text-secondary">
          {stateFilter
            ? t("advancing.guests.emptyFiltered", { state: label(stateFilter) })
            : can.rider
              ? t("advancing.guests.empty")
              : t("advancing.guests.emptyReadOnly")}
        </p>
      ) : view === "table" ? (
        <PeekTable
          caption={title}
          columns={[
            { key: "guest", label: t("advancing.guests.columns.guest") },
            { key: "plusOnes", label: t("advancing.guests.columns.plusOnes"), type: "number" },
            { key: "show", label: t("advancing.guests.columns.show") },
            { key: "from", label: t("advancing.guests.columns.from") },
            { key: "state", label: t("advancing.common.state") },
          ]}
          rows={guests.data.map((g) => ({
            id: g.id,
            guest: g.guestName,
            plusOnes: g.plusOnes,
            show: scopeName(g.scopeNodeId),
            from: from(g),
            state: label(g.state),
          }))}
        />
      ) : (
        <ul
          aria-label={title}
          className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0"
        >
          {guests.data.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center justify-between gap-8 px-16 py-8">
              <div className="flex min-w-0 flex-wrap items-center gap-8">
                <StateChip state={GUEST_RECORD_STATE[g.state]} label={label(g.state)} compact />
                <Link
                  href={withQuery(path, search, { peek: g.id }) as Route}
                  className="text-text-14 text-text-primary hover:underline"
                >
                  {g.guestName}
                </Link>
                <span className="text-text-12 text-text-secondary">
                  {t("advancing.guests.plusOnes", { count: g.plusOnes })} ·{" "}
                  {scopeName(g.scopeNodeId)} · {from(g)}
                </span>
                {g.engagementId ? (
                  <Tag tone="accent">{t("advancing.guests.viaGateway")}</Tag>
                ) : null}
              </div>
              <GuestActions
                org={ctx.org.slug}
                guest={item(g)}
                state={g.state}
                scopes={scopeOptions}
                canEdit={can.rider}
                canReview={can.review}
              />
            </li>
          ))}
        </ul>
      )}
      {peek ? (
        <PeekPanel
          full={false}
          title={peek.guestName}
          state={GUEST_RECORD_STATE[peek.state]}
          stateLabel={label(peek.state)}
          properties={[
            { label: t("advancing.guests.columns.plusOnes"), value: peek.plusOnes },
            { label: t("advancing.guests.columns.show"), value: scopeName(peek.scopeNodeId) },
            { label: t("advancing.guests.columns.from"), value: from(peek) },
            {
              label: t("advancing.guests.requested"),
              value: format.dateTime(new Date(peek.createdAt), {
                dateStyle: "medium",
                timeStyle: "short",
              }),
            },
            ...(peek.note ? [{ label: t("advancing.guests.form.note"), value: peek.note }] : []),
          ]}
        >
          <RecordCollab
            actx={actx}
            table="app.guest_list_entries"
            id={peek.id}
            canUpload={can.rider}
          />
        </PeekPanel>
      ) : null}
    </div>
  );
}
