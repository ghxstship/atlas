import {
  getContentReportDetail,
  listContentModerationQueue,
  type ContentModerationAction,
  type ContentQueueItem,
  type ContentReportReason,
  type ContentSubjectKind,
} from "@xos/data/content-safety";
import { getFormatter } from "next-intl/server";
import { notFound } from "next/navigation";
import { CollectionView } from "@/components/collection-kit/collection-view";
import {
  EmptyRefresh,
  EntityForm,
  ErrorPanel,
  KitSection,
  PeekDrawer,
} from "@/components/collection-kit/kit";
import type { KitRow, KitState, ViewKind } from "@/components/collection-kit/types";
import { PageHeader } from "@/components/collection-kit/ui";
import type { Copy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import { decideContentReportAction } from "@/lib/workforce/moderation-actions";
import { QuerySwitch } from "./client";
import { REFUSALS, workforceCopy } from "./shared";

const VIEWS: readonly ViewKind[] = ["table", "list"];

const KIND_KEYS: Readonly<Record<ContentSubjectKind, string>> = {
  "Feed Post": "feedPost",
  Comment: "comment",
  "Chat Message": "chatMessage",
};

const REASON_KEYS: Readonly<Record<ContentReportReason, string>> = {
  Harassment: "harassment",
  Hate: "hate",
  "Sexual Content": "sexualContent",
  Violence: "violence",
  Spam: "spam",
  Other: "other",
};

const ACTION_KEYS: Readonly<Record<ContentModerationAction, string>> = {
  Removed: "removed",
  "No Action": "noAction",
};

function itemState(i: ContentQueueItem, t: Copy): KitState {
  if (i.openReports > 0) {
    return i.overdue
      ? { state: "blocked", label: t("moderation.states.overdue") }
      : { state: "in-review", label: t("moderation.states.open") };
  }
  return i.lastAction === "Removed" || i.removed
    ? { state: "canceled", label: t("moderation.states.removed") }
    : { state: "complete", label: t("moderation.states.noAction") };
}

/** The first line of a text, cut to a title's length. */
function headline(text: string): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

/**
 * People > Reported Content (owner decision 19, App Store Review Guideline 1.2): the posts, comments on posts and
 * chat messages people reported, the one due first at the top, for the org's moderators (org.communication.write).
 * Each opens with what was reported, every report and every decision; a moderator decides it with a statement of
 * reasons in parts, as A90's console does for listings. The database decides who may decide and what removal does.
 */
export async function ModerationSection({
  ctx,
  path,
  search,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
}) {
  if (!ctx.capabilities.has("org.communication.write")) notFound();
  const section = search["section"] === "decided" ? "decided" : "open";
  const state = collectionState(search, VIEWS, await orgToday(ctx));
  const scoped = {
    ...state,
    baseQuery: new URLSearchParams({
      ...Object.fromEntries(new URLSearchParams(state.baseQuery)),
      section,
    }).toString(),
  };
  const [t, format, queue] = await Promise.all([
    workforceCopy(),
    getFormatter(),
    listContentModerationQueue(ctx.viewer.db, ctx.org.id, section === "open"),
  ]);
  const title = t("moderation.title");
  const tabs = (
    <QuerySwitch
      label={t("moderation.sections")}
      name="section"
      value={section}
      options={[
        { value: "open", label: t("moderation.open") },
        { value: "decided", label: t("moderation.decided") },
      ]}
    />
  );
  if (!queue.ok) {
    return (
      <>
        <PageHeader title={title} />
        {tabs}
        <ErrorPanel what={t("moderation.what")} />
      </>
    );
  }
  const when = (d: string) =>
    format.dateTime(new Date(d), { dateStyle: "medium", timeStyle: "short" });
  const kindOf = (k: ContentSubjectKind) => t(`moderation.kinds.${KIND_KEYS[k]}`);
  const reasonOf = (r: ContentReportReason) => t(`moderation.reasons.${REASON_KEYS[r]}`);
  const selected = state.peek ? queue.data.find((i) => i.id === state.peek) : undefined;

  let drawer = null;
  if (selected) {
    const detail = await getContentReportDetail(ctx.viewer.db, ctx.org.id, {
      kind: selected.kind,
      id: selected.id,
    });
    drawer = (
      <PeekDrawer
        recordKey={kindOf(selected.kind)}
        title={headline(selected.excerpt)}
        state={itemState(selected, t)}
        closeHref={withQuery(path, scoped)}
        fullHref={withQuery(path, scoped, { peek: selected.id })}
        properties={[
          { label: t("moderation.author"), value: selected.authorName ?? t("someone") },
          {
            label: t("moderation.where"),
            value: detail.ok ? (detail.data.subject.context ?? kindOf(selected.kind)) : "",
          },
          {
            label: t("moderation.firstReported"),
            value: selected.firstReportedAt ? when(selected.firstReportedAt) : "",
          },
          { label: t("moderation.due"), value: selected.dueAt ? when(selected.dueAt) : "" },
        ]}
      >
        {!detail.ok ? (
          <ErrorPanel what={t("moderation.what")} />
        ) : (
          <>
            {detail.data.subject.removed ? (
              <p className="m-0 text-text-13 text-text-secondary">{t("moderation.removedNote")}</p>
            ) : null}
            <KitSection
              id="moderation-content"
              title={
                detail.data.subject.body === null
                  ? t("moderation.snapshot")
                  : t("moderation.current")
              }
            >
              <p className="m-0 whitespace-pre-wrap text-text-14">
                {detail.data.subject.body ?? selected.excerpt}
              </p>
            </KitSection>
            <KitSection id="moderation-reports" title={t("moderation.reports")}>
              <ul className="m-0 flex list-none flex-col gap-12 p-0 text-text-13">
                {detail.data.reports.map((r) => (
                  <li key={r.id} className="flex flex-col gap-4">
                    <span>
                      {t("moderation.reportLine", {
                        reason: reasonOf(r.reason),
                        name: r.reporterName ?? t("someone"),
                        date: when(r.reportedAt),
                      })}
                    </span>
                    <span className="text-text-secondary">
                      {r.details ?? t("moderation.noDetails")}
                    </span>
                    {detail.data.subject.body !== null && r.excerpt !== detail.data.subject.body ? (
                      <span className="whitespace-pre-wrap text-text-secondary">
                        {t("moderation.snapshot")}: {r.excerpt}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </KitSection>
            {detail.data.decisions.length > 0 ? (
              <KitSection id="moderation-decisions" title={t("moderation.decisions")}>
                <ul className="m-0 flex list-none flex-col gap-12 p-0 text-text-13">
                  {detail.data.decisions.map((d) => (
                    <li key={d.id} className="flex flex-col gap-4">
                      <span>
                        {t("moderation.decisionLine", {
                          action: t(`moderation.actions.${ACTION_KEYS[d.action]}`),
                          date: when(d.decidedAt),
                          name: d.decidedByName ?? t("someone"),
                        })}
                      </span>
                      <span className="text-text-secondary">{d.ruleReference}</span>
                      <span className="whitespace-pre-wrap">{d.statement}</span>
                    </li>
                  ))}
                </ul>
              </KitSection>
            ) : null}
            {selected.openReports > 0 ? (
              detail.data.subject.decidableByMe ? (
                <KitSection id="moderation-decide" title={t("moderation.decide")}>
                  <EntityForm
                    id={`moderation-decide-${selected.id}`}
                    action={decideContentReportAction}
                    hidden={{ org: ctx.org.slug, id: selected.id, kind: selected.kind }}
                    refusals={REFUSALS}
                    submitLabel={t("moderation.submit")}
                    successHref={withQuery(path, scoped)}
                    fields={[
                      {
                        kind: "select",
                        name: "decision",
                        label: t("moderation.decision"),
                        required: true,
                        defaultValue: "removeTerms",
                        options: ["removeTerms", "removeIllegal", "noAction"].map((c) => ({
                          value: c,
                          label: t(`moderation.choices.${c}`),
                        })),
                      },
                      {
                        kind: "text",
                        name: "ruleReference",
                        label: t("moderation.ruleReference"),
                        help: t("moderation.ruleReferenceHelp"),
                        required: true,
                      },
                      {
                        kind: "textarea",
                        name: "facts",
                        label: t("moderation.facts"),
                        help: t("moderation.factsHelp"),
                        required: true,
                        rows: 3,
                      },
                      {
                        kind: "textarea",
                        name: "statement",
                        label: t("moderation.statement"),
                        help: t("moderation.statementHelp"),
                        required: true,
                        rows: 4,
                      },
                    ]}
                  />
                </KitSection>
              ) : (
                <p className="m-0 text-text-13 text-text-secondary">{t("moderation.notYours")}</p>
              )
            ) : null}
          </>
        )}
      </PeekDrawer>
    );
  }

  const rows: KitRow[] = queue.data.map((i) => {
    const reasons = i.reasons.map(reasonOf).join(", ");
    return {
      id: i.id,
      key: kindOf(i.kind),
      title: headline(i.excerpt),
      state: itemState(i, t),
      meta: t("moderation.line", {
        kind: kindOf(i.kind),
        author: i.authorName ?? t("someone"),
        reasons,
      }),
      cells: {
        content: headline(i.excerpt),
        kind: kindOf(i.kind),
        author: i.authorName ?? t("someone"),
        reports: t("moderation.reportsCount", { open: i.openReports, total: i.totalReports }),
        reasons,
        state: itemState(i, t),
        due: i.dueAt ? when(i.dueAt) : i.lastDecidedAt ? when(i.lastDecidedAt) : "",
      },
    };
  });
  return (
    <>
      <p className="m-0 text-text-13 text-text-secondary">{t("moderation.intro")}</p>
      <CollectionView
        title={title}
        views={VIEWS}
        view={state.view}
        columns={[
          { key: "content", label: t("moderation.content"), wrap: true },
          { key: "kind", label: t("moderation.kind") },
          { key: "author", label: t("moderation.author") },
          { key: "reports", label: t("moderation.reports") },
          { key: "reasons", label: t("moderation.reasonsLabel"), wrap: true },
          { key: "state", label: t("feed.state"), type: "state" },
          { key: "due", label: t("moderation.due") },
        ]}
        rows={rows}
        filters={tabs}
        empty={
          <EmptyRefresh
            icon="ShieldCheck"
            sentence={section === "open" ? t("moderation.empty") : t("moderation.emptyDecided")}
          />
        }
      >
        {drawer}
      </CollectionView>
    </>
  );
}
