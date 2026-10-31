import {
  GUEST_STATES,
  guestEmailSkip,
  listGuestEmailSends,
  listGuests,
  listProjectScopes,
  type GuestEntry,
  type GuestState,
} from "@xos/data/advancing";
import { listCredentialCategories } from "@xos/data/credentials";
import type { RecordState } from "@xos/ui";
import Link from "next/link";
import type { Route } from "next";
import dynamic from "next/dynamic";
import { notFound } from "next/navigation";
import { getFormatter, getLocale } from "next-intl/server";
import { documentHref } from "@/lib/documents/links";
import { projectPeople, projectPersonLabel } from "@/lib/people/project-people";
import { collectionPeek } from "@/components/shell/collection-peek";
import { getTranslate } from "@/lib/shell/translate";
import type { AdvancingContext } from "./context";
import { AddGuestDialog, GuestActions } from "./guest-forms";
import { RecordCollab } from "./record-collab";
import { isRowId, partyLabel, pickView, withQuery, type Search } from "./shared";
import { PageHeader, StateChip, Tag } from "./ui";
import { PeekPanel, PeekTable, SelectFilter, ViewSwitcher } from "./views";
import { CollectionPage } from "@/components/platform/collection-page";
import { importLinkHref } from "@/lib/imports/import-link";

// The Email guests dialog loads with its first open, so the guest list carries none of its code (bundle budget).
const GuestEmailDialog = dynamic(() =>
  import("./guest-email-dialog").then((m) => m.GuestEmailDialog),
);

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
 * table views with a state filter, a peek with comments and attachments, and totals with plus-ones. B8 (2974, 2975):
 * each guest's pass (type, table, host, email and the code stamped on approval), the pass PDF for an approved guest,
 * and bulk guest emails with what each send did.
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
  const [guests, scopes, categories, people, sends, locale] = await Promise.all([
    listGuests(ctx.viewer.db, {
      orgId: ctx.org.id,
      projectId: project.id,
      ...(stateFilter ? { state: stateFilter } : {}),
    }),
    listProjectScopes(ctx.viewer.db, project.id),
    listCredentialCategories(ctx.viewer.db, { orgId: ctx.org.id, projectId: project.id }),
    can.rider ? projectPeople(ctx, project.id) : Promise.resolve([]),
    listGuestEmailSends(ctx.viewer.db, project.id),
    getLocale(),
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
  // A key that is no guest id (a record key from elsewhere) goes to the shell's peek; an id
  // outside the list answers 404.
  const peekId = search["peek"];
  const peek = peekId ? guests.data.find((g) => g.id === peekId) : undefined;
  if (peekId && isRowId(peekId) && !peek) notFound();
  const item = (g: GuestEntry) => ({
    id: g.id,
    guestName: g.guestName,
    plusOnes: g.plusOnes,
    note: g.note,
    scopeNodeId: g.scopeNodeId,
    passCategoryId: g.passCategoryId,
    tableLabel: g.tableLabel,
    hostPersonId: g.hostPersonId,
    guestEmail: g.guestEmail,
  });
  // Pass types are the project's Access categories; hosts are its people (members and the engaged).
  const accessCategories = (categories.ok ? categories.data : []).filter(
    (c) => c.kind === "Access",
  );
  const passTypeName = (id: string | null) => {
    const c = accessCategories.find((x) => x.id === id);
    return c ? `${c.code} · ${c.name}` : "";
  };
  const hostOptions = people.map((p) => ({
    value: p.personId,
    label: projectPersonLabel(t, p, t("credentials.common.unnamed")),
  }));
  const choices = {
    passTypes: accessCategories.map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` })),
    hosts: hostOptions,
  };
  const hostName = (id: string | null) =>
    id
      ? (hostOptions.find((h) => h.value === id)?.label ?? t("advancing.guests.pass.someHost"))
      : null;
  const hasPass = (g: GuestEntry) =>
    (g.state === "Approved" || g.state === "Checked In") && g.passCode !== null;
  const guestName = (id: string) => guests.data.find((g) => g.id === id)?.guestName ?? "";
  const importHref = importLinkHref(ctx.org.slug, ctx.nav, can.rider, {
    target: "guest_list_entries",
    projectId: project.id,
  });

  return (
    <CollectionPage
      gap={12}
      header={
        <PageHeader
          title={title}
          count={guests.data.length}
          views={<ViewSwitcher views={VIEWS} current={view} />}
          {...(can.rider
            ? {
                actions: (
                  <>
                    {importHref ? (
                      <Link href={importHref} className="text-text-13 text-accent-text underline">
                        {t("advancing.guests.import")}
                      </Link>
                    ) : null}
                    {guests.data.length > 0 ? (
                      <GuestEmailDialog
                        org={ctx.org.slug}
                        projectId={project.id}
                        projectName={project.name}
                        locale={locale === "es-US" ? "es-US" : "en-US"}
                        guests={guests.data.map((g) => ({
                          id: g.id,
                          name: g.guestName,
                          skip: {
                            any: guestEmailSkip(g, "Invitation"),
                            pass: guestEmailSkip(g, "Pass"),
                          },
                        }))}
                      />
                    ) : null}
                    <AddGuestDialog
                      org={ctx.org.slug}
                      projectId={project.id}
                      scopes={scopeOptions}
                      choices={choices}
                      canApprove={can.review}
                    />
                  </>
                ),
              }
            : {})}
        />
      }
    >
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
            { key: "passType", label: t("advancing.guests.columns.passType") },
            { key: "table", label: t("advancing.guests.columns.table") },
            { key: "state", label: t("advancing.common.state") },
          ]}
          full={false}
          bulk={
            can.rider
              ? {
                  org: ctx.org.slug,
                  resource: "guest_list_entries",
                  // The guest list guard decides each move: review authority, never the requester.
                  fields: [
                    {
                      key: "entry_state",
                      label: t("advancing.common.state"),
                      options: GUEST_STATES.filter((s) => s !== "Requested").map((s) => ({
                        value: s,
                        label: label(s),
                      })),
                    },
                  ],
                }
              : null
          }
          rows={guests.data.map((g) => ({
            id: g.id,
            label: g.guestName,
            guest: g.guestName,
            plusOnes: g.plusOnes,
            show: scopeName(g.scopeNodeId),
            from: from(g),
            passType: passTypeName(g.passCategoryId),
            table: g.tableLabel ?? "",
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
                  {g.passCategoryId ? ` · ${passTypeName(g.passCategoryId)}` : ""}
                  {g.tableLabel ? ` · ${g.tableLabel}` : ""}
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
                choices={choices}
                canEdit={can.rider}
                canReview={can.review}
              />
            </li>
          ))}
        </ul>
      )}
      {collectionPeek(
        peekId,
        peek ? (
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
              ...(peek.passCategoryId
                ? [
                    {
                      label: t("advancing.guests.pass.type"),
                      value: passTypeName(peek.passCategoryId),
                    },
                  ]
                : []),
              ...(peek.tableLabel
                ? [{ label: t("advancing.guests.pass.table"), value: peek.tableLabel }]
                : []),
              ...(peek.hostPersonId
                ? [
                    {
                      label: t("advancing.guests.pass.host"),
                      value: hostName(peek.hostPersonId) ?? "",
                    },
                  ]
                : []),
              ...(peek.guestEmail
                ? [{ label: t("advancing.guests.pass.email"), value: peek.guestEmail }]
                : []),
              {
                label: t("advancing.guests.pass.code"),
                value: peek.passCode ?? t("advancing.guests.pass.notApproved"),
              },
            ]}
          >
            {hasPass(peek) ? (
              <div className="flex flex-wrap gap-8">
                <Link
                  href={`${documentHref(ctx.org.slug, "guest-pass", peek.id)}?paper=a6` as Route}
                  target="_blank"
                  className="text-text-13 text-accent-text underline"
                >
                  {t("advancing.guests.pass.print")}
                </Link>
                <a
                  href={`${documentHref(ctx.org.slug, "guest-pass", peek.id)}?paper=a6`}
                  download
                  className="text-text-13 text-accent-text underline"
                >
                  {t("advancing.guests.pass.download")}
                </a>
              </div>
            ) : null}
            <RecordCollab
              actx={actx}
              table="app.guest_list_entries"
              id={peek.id}
              canUpload={can.rider}
            />
          </PeekPanel>
        ) : null,
      )}
      {sends.ok && sends.data.length > 0 ? (
        <section aria-labelledby="guest-email-sends" className="flex flex-col gap-8">
          <h2 id="guest-email-sends" className="m-0 text-text-14 font-semibold">
            {t("advancing.guests.email.sendsTitle")}
          </h2>
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle rounded-card border border-border-subtle p-0">
            {sends.data.map((send) => (
              <li key={send.id} className="px-16 py-8">
                <details>
                  <summary className="cursor-pointer text-text-13">
                    {t(`advancing.guests.email.kinds.${send.kind}`)}
                    {send.subject ? ` · ${send.subject}` : ""} ·{" "}
                    {format.dateTime(new Date(send.createdAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}{" "}
                    ·{" "}
                    {t("advancing.guests.email.sent", {
                      count: send.rows.filter(
                        (r) => r.state !== "Skipped" && r.state !== "Suppressed",
                      ).length,
                    })}
                  </summary>
                  <ul className="m-0 flex list-none flex-col gap-2 p-0 pt-8 text-text-13">
                    {send.rows.map((r) => (
                      <li key={r.guestListEntryId} className="flex flex-wrap justify-between gap-8">
                        <span>
                          {guestName(r.guestListEntryId) ||
                            t("advancing.guests.email.removedGuest")}
                        </span>
                        <span className="text-text-secondary">
                          {t(`advancing.guests.email.states.${r.state}`)}
                          {r.skipReason
                            ? ` · ${t(`advancing.guests.email.skipReasons.${r.skipReason.replace(/ /g, "")}`)}`
                            : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </CollectionPage>
  );
}
