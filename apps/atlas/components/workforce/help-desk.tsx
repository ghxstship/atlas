import {
  listHelpDeskMessages,
  listHelpDeskRequests,
  listHelpDeskTeams,
  responseOverdue,
  HELP_DESK_NEXT,
  SUPPORT_CATEGORIES,
  SUPPORT_SEVERITIES,
  type HelpDeskRequest,
} from "@xos/data/workforce-help-desk";
import { getFormatter } from "next-intl/server";
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
  TransitionButtons,
} from "@/components/collection-kit/kit";
import type { KitBoardColumn, KitRow, KitState, ViewKind } from "@/components/collection-kit/types";
import { InlineAlert, PageHeader } from "@/components/collection-kit/ui";
import { EmptyStateLink } from "@/components/ui";
import {
  answerRequestAction,
  assignRequestAction,
  openRequestAction,
  transitionRequestAction,
} from "@/lib/workforce/actions";
import type { Copy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import { REFUSALS, workforceCopy } from "./shared";

const VIEWS: readonly ViewKind[] = ["table", "list", "board"];
const STATE_MAP = {
  Open: "active",
  Waiting: "blocked",
  Resolved: "complete",
  Closed: "canceled",
} as const;

function requestState(r: HelpDeskRequest, t: Copy): KitState {
  return { state: STATE_MAP[r.state], label: t(`helpDesk.states.${r.state}`) };
}

/**
 * People > Help Desk (Section 4.9 Help desk): requests to internal teams (operations, IT, HR,
 * facilities) with categories, assignment and a first response target. Anyone asks; members of the
 * team, and help admins, see their queue, take requests, answer and resolve them. Teams are set up in
 * Settings, Help and Support.
 */
export async function HelpDeskSection({
  ctx,
  path,
  search,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
}) {
  const state = collectionState(search, VIEWS, await orgToday(ctx));
  const db = ctx.viewer.db;
  const [t, format, requests, teams] = await Promise.all([
    workforceCopy(),
    getFormatter(),
    listHelpDeskRequests(db, ctx.org.id),
    listHelpDeskTeams(db, ctx.org.id),
  ]);
  const title = t("helpDesk.title");
  if (!requests.ok || !teams.ok) {
    return (
      <>
        <PageHeader title={title} />
        <ErrorPanel what={t("helpDesk.what")} />
      </>
    );
  }
  const me = ctx.org.membershipId;
  const admin = ctx.capabilities.has("org.help.write");
  const activeTeams = teams.data.filter((x) => x.archivedAt === null);
  const myTeams = new Set(
    teams.data.filter((x) => x.members.some((m) => m.membershipId === me)).map((x) => x.id),
  );
  const teamName = (id: string | null) =>
    teams.data.find((x) => x.id === id)?.name ?? t("helpDesk.noTeam");
  const when = (d: string) =>
    format.dateTime(new Date(d), { dateStyle: "medium", timeStyle: "short" });
  const selected = state.peek ? requests.data.find((r) => r.id === state.peek) : undefined;
  const createHref = withQuery(path, state, { create: "1" });

  let drawer = null;
  if (state.create) {
    drawer = (
      <FormDrawer title={t("helpDesk.create")} closeHref={withQuery(path, state)}>
        {activeTeams.length === 0 ? (
          <InlineAlert tone="info" title={t("helpDesk.noTeamsTitle")}>
            {t("helpDesk.noTeamsBody")}
          </InlineAlert>
        ) : (
          <EntityForm
            id="request-open"
            action={openRequestAction}
            hidden={{ org: ctx.org.slug }}
            refusals={REFUSALS}
            submitLabel={t("helpDesk.send")}
            successHref={withQuery(path, state, { peek: "{id}" })}
            fields={[
              {
                kind: "select",
                name: "teamId",
                label: t("helpDesk.team"),
                required: true,
                blankLabel: t("feed.pickOne"),
                options: activeTeams.map((x) => ({
                  value: x.id,
                  label: t("helpDesk.teamOption", { name: x.name, hours: x.firstResponseHours }),
                })),
              },
              {
                kind: "select",
                name: "category",
                label: t("helpDesk.category"),
                required: true,
                defaultValue: "Question",
                options: SUPPORT_CATEGORIES.map((c) => ({
                  value: c,
                  label: t(`helpDesk.categories.${c}`),
                })),
              },
              {
                kind: "select",
                name: "severity",
                label: t("helpDesk.severity"),
                defaultValue: "Severity 3",
                options: SUPPORT_SEVERITIES.map((s) => ({
                  value: s,
                  label: t(`helpDesk.severities.${s.replace(" ", "")}`),
                })),
              },
              { kind: "text", name: "subject", label: t("helpDesk.subject"), required: true },
              {
                kind: "textarea",
                name: "body",
                label: t("helpDesk.body"),
                required: true,
                rows: 5,
                help: t("helpDesk.bodyHelp"),
              },
            ]}
          />
        )}
      </FormDrawer>
    );
  } else if (selected) {
    const responder = admin || (selected.teamId !== null && myTeams.has(selected.teamId));
    const team = teams.data.find((x) => x.id === selected.teamId);
    const messages = await listHelpDeskMessages(db, selected.id);
    drawer = (
      <PeekDrawer
        recordKey={selected.number}
        title={selected.subject}
        state={requestState(selected, t)}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id })}
        properties={[
          { label: t("helpDesk.team"), value: teamName(selected.teamId) },
          { label: t("helpDesk.requester"), value: selected.requesterName ?? t("someone") },
          {
            label: t("helpDesk.assignee"),
            value: selected.assigneeName ?? t("helpDesk.unassigned"),
          },
          { label: t("helpDesk.category"), value: t(`helpDesk.categories.${selected.category}`) },
          {
            label: t("helpDesk.responseDue"),
            value: selected.firstRespondedAt
              ? t("helpDesk.answeredAt", { time: when(selected.firstRespondedAt) })
              : selected.responseDueAt
                ? `${when(selected.responseDueAt)}${responseOverdue(selected) ? ` · ${t("helpDesk.overdue")}` : ""}`
                : t("helpDesk.noTarget"),
          },
        ]}
        actions={
          responder ? (
            <>
              {selected.assigneeMembershipId !== me &&
              team?.members.some((m) => m.membershipId === me) &&
              selected.state !== "Closed" ? (
                <ActionButton
                  action={assignRequestAction}
                  hidden={{ org: ctx.org.slug, id: selected.id, membershipId: me }}
                  label={t("helpDesk.take")}
                  refusals={REFUSALS}
                />
              ) : null}
              <TransitionButtons
                action={transitionRequestAction}
                org={ctx.org.slug}
                id={selected.id}
                expected={selected.state}
                moves={HELP_DESK_NEXT[selected.state].map((next) => ({
                  next,
                  label: t(`helpDesk.moves.${next}`),
                  danger: next === "Closed",
                }))}
                refusals={REFUSALS}
              />
            </>
          ) : null
        }
      >
        <p className="m-0 whitespace-pre-wrap text-text-14">{selected.body}</p>
        <KitSection id="request-thread" title={t("helpDesk.conversation")}>
          {!messages.ok ? (
            <ErrorPanel what={t("helpDesk.conversation")} />
          ) : messages.data.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("helpDesk.noMessages")}</p>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-8 p-0 text-text-13">
              {messages.data.map((m) => (
                <li key={m.id} className="flex flex-col gap-2">
                  <span className="text-text-12 text-text-secondary">
                    {m.authorName ?? t("helpDesk.platformTeam")} · {when(m.createdAt)}
                  </span>
                  <span className="whitespace-pre-wrap">{m.body}</span>
                </li>
              ))}
            </ol>
          )}
          {selected.state !== "Closed" && (responder || selected.requesterMembershipId === me) ? (
            <EntityForm
              id={`request-answer-${selected.id}`}
              action={answerRequestAction}
              hidden={{ org: ctx.org.slug, id: selected.id }}
              refusals={REFUSALS}
              submitLabel={responder ? t("helpDesk.answer") : t("helpDesk.reply")}
              fields={[
                {
                  kind: "textarea",
                  name: "body",
                  label: t("helpDesk.message"),
                  required: true,
                  rows: 4,
                },
              ]}
            />
          ) : null}
        </KitSection>
        {responder && team ? (
          <KitSection id="request-assign" title={t("helpDesk.assign")}>
            <EntityForm
              id={`request-assign-${selected.id}`}
              action={assignRequestAction}
              hidden={{ org: ctx.org.slug, id: selected.id }}
              refusals={REFUSALS}
              submitLabel={t("helpDesk.assign")}
              fields={[
                {
                  kind: "select",
                  name: "teamId",
                  label: t("helpDesk.team"),
                  defaultValue: team.id,
                  options: activeTeams.map((x) => ({ value: x.id, label: x.name })),
                },
                {
                  kind: "select",
                  name: "membershipId",
                  label: t("helpDesk.assignee"),
                  blankLabel: t("helpDesk.unassigned"),
                  defaultValue: selected.assigneeMembershipId ?? "",
                  options: team.members.map((m) => ({
                    value: m.membershipId,
                    label: m.name ?? t("someone"),
                  })),
                  help: t("helpDesk.assignHelp"),
                },
              ]}
            />
          </KitSection>
        ) : null}
      </PeekDrawer>
    );
  }

  const board: KitBoardColumn[] = (["Open", "Waiting", "Resolved", "Closed"] as const).map((s) => ({
    value: s,
    state: STATE_MAP[s],
    label: t(`helpDesk.states.${s}`),
  }));
  const rows: KitRow[] = requests.data.map((r) => ({
    id: r.id,
    key: r.number,
    title: r.subject,
    state: requestState(r, t),
    boardValue: r.state,
    meta: t("helpDesk.line", { team: teamName(r.teamId), name: r.requesterName ?? t("someone") }),
    cells: {
      number: r.number,
      subject: r.subject,
      state: requestState(r, t),
      team: teamName(r.teamId),
      assignee: r.assigneeName ?? t("helpDesk.unassigned"),
      due: r.firstRespondedAt
        ? t("helpDesk.answered")
        : r.responseDueAt
          ? `${when(r.responseDueAt)}${responseOverdue(r) ? ` · ${t("helpDesk.overdue")}` : ""}`
          : null,
    },
  }));
  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      board={board}
      columns={[
        { key: "number", label: t("helpDesk.number"), type: "code" },
        { key: "subject", label: t("helpDesk.subject"), wrap: true },
        { key: "state", label: t("feed.state"), type: "state" },
        { key: "team", label: t("helpDesk.team") },
        { key: "assignee", label: t("helpDesk.assignee") },
        { key: "due", label: t("helpDesk.responseDue") },
      ]}
      rows={rows}
      actions={
        <KitLink href={createHref} variant="primary">
          {t("helpDesk.create")}
        </KitLink>
      }
      empty={
        activeTeams.length > 0 || admin ? (
          <EmptyStateLink
            icon="LifeBuoy"
            sentence={t("helpDesk.empty")}
            actionLabel={t("helpDesk.create")}
            href={createHref}
            secondary
          />
        ) : (
          <EmptyRefresh icon="LifeBuoy" sentence={t("helpDesk.noTeamsBody")} />
        )
      }
    >
      {drawer}
    </CollectionView>
  );
}
