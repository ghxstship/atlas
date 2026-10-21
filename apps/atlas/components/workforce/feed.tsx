import {
  getPollResults,
  getSurveyResults,
  listAcknowledgmentStatus,
  listFeed,
  listSurveys,
  REACTION_CODES,
  responseRate,
  votePercent,
  type FeedPost,
  type Survey,
} from "@xos/data/workforce-feed";
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
  TransitionButtons,
} from "@/components/collection-kit/kit";
import type { KitRow, KitState, ViewKind } from "@/components/collection-kit/types";
import { Card, InlineAlert, PageHeader } from "@/components/collection-kit/ui";
import { EmptyStateLink } from "@/components/ui";
import {
  acknowledgePostAction,
  createPostAction,
  createSurveyAction,
  hidePostAction,
  pinPostAction,
  postSwitchesAction,
  respondSurveyAction,
  transitionSurveyAction,
  voteAction,
} from "@/lib/workforce/actions";
import type { Copy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import { requestNow } from "@/lib/workforce/time";
import { QuerySwitch } from "./client";
import { OverflowMenu } from "./overflow-menu";
import { ReactionBar } from "./reaction-bar";
import {
  REFUSALS,
  audienceFields,
  audienceLabel,
  orgPickers,
  workforceCopy,
  type OrgPickers,
} from "./shared";

const VIEWS: readonly ViewKind[] = ["list", "table"];

function postState(p: FeedPost, t: Copy): KitState {
  if (p.hiddenAt) return { state: "canceled", label: t("feed.states.hidden") };
  if (Date.parse(p.publishAt) > Date.now())
    return { state: "scheduled", label: t("feed.states.scheduled") };
  if (p.pinnedAt) return { state: "active", label: t("feed.states.pinned") };
  return { state: "complete", label: t("feed.states.published") };
}

function surveyState(s: Survey, t: Copy): KitState {
  return s.state === "Draft"
    ? { state: "proposed", label: t("surveys.states.Draft") }
    : s.state === "Open"
      ? { state: "active", label: t("surveys.states.Open") }
      : { state: "complete", label: t("surveys.states.Closed") };
}

/**
 * Knowledge > Feed (Section 4.9 Feed, Polls and surveys): announcements and updates for an audience,
 * pinned first, with required acknowledgments, reactions, comments and quick polls; and pulse surveys
 * that show results only once enough people respond. The database decides who posts, pins and sees.
 */
export async function FeedSection({
  ctx,
  path,
  search,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
}) {
  const section = search["section"] === "surveys" ? "surveys" : "posts";
  const t = await workforceCopy();
  const tabs = (
    <QuerySwitch
      label={t("feed.sections")}
      name="section"
      value={section}
      options={[
        { value: "posts", label: t("feed.posts") },
        { value: "surveys", label: t("surveys.title") },
      ]}
    />
  );
  return section === "surveys" ? (
    <SurveysSection ctx={ctx} path={path} search={search} t={t} tabs={tabs} />
  ) : (
    <PostsSection ctx={ctx} path={path} search={search} t={t} tabs={tabs} />
  );
}

async function PostsSection({
  ctx,
  path,
  search,
  t,
  tabs,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
  t: Copy;
  tabs: React.ReactNode;
}) {
  const feedView = search["view"] === undefined || search["view"] === "feed";
  const state = collectionState(search, VIEWS, await orgToday(ctx));
  const mine = [ctx.org.membershipId];
  const [format, feed, pickers] = await Promise.all([
    getFormatter(),
    listFeed(ctx.viewer.db, ctx.org.id, mine),
    orgPickers(ctx),
  ]);
  const title = t("feed.title");
  if (!feed.ok) {
    return (
      <>
        <PageHeader title={title} />
        <ErrorPanel what={t("feed.what")} />
      </>
    );
  }
  const canPost = ctx.capabilities.has("knowledge.document.write");
  const canAnnounce = ctx.capabilities.has("knowledge.sop.publish");
  const canModerate = ctx.capabilities.has("org.communication.write");
  const when = (d: string) =>
    format.dateTime(new Date(d), { dateStyle: "medium", timeStyle: "short" });
  const selected = state.peek ? feed.data.find((p) => p.id === state.peek) : undefined;
  const createHref = withQuery(path, state, { create: "1" });
  const viewSwitch = (
    <QuerySwitch
      label={t("views")}
      name="view"
      value={feedView ? "feed" : state.view}
      options={[
        { value: "feed", label: t("view.feed") },
        { value: "list", label: t("view.list") },
        { value: "table", label: t("view.table") },
      ]}
    />
  );

  /** Acknowledge stays visible; pinning and moderation sit in the post's More menu (A59-027). */
  const acknowledge = (p: FeedPost) =>
    p.requiresAcknowledgment && !p.acknowledgedByMe && !p.hiddenAt ? (
      <ActionButton
        action={acknowledgePostAction}
        hidden={{ org: ctx.org.slug, id: p.id }}
        label={t("feed.acknowledge")}
        variant="secondary"
        refusals={REFUSALS}
      />
    ) : null;

  const moreActions = (p: FeedPost) => {
    const mineAuthor = p.authorMembershipId === ctx.org.membershipId;
    const canPin = (mineAuthor || canModerate) && (canAnnounce || canModerate) && !p.hiddenAt;
    const canSwitch = (mineAuthor || canModerate) && !p.hiddenAt;
    if (!canPin && !canSwitch) return null;
    return (
      <OverflowMenu
        label={t("feed.more")}
        title={t("feed.moreFor", { title: p.title ?? t(`feed.kinds.${p.kind}`) })}
      >
        {canPin ? (
          <ActionButton
            action={pinPostAction}
            hidden={{ org: ctx.org.slug, id: p.id, pinned: p.pinnedAt ? "false" : "true" }}
            label={p.pinnedAt ? t("feed.unpin") : t("feed.pin")}
            variant="ghost"
            refusals={REFUSALS}
          />
        ) : null}
        {canSwitch ? (
          <>
            <ActionButton
              action={postSwitchesAction}
              hidden={{
                org: ctx.org.slug,
                id: p.id,
                comments: p.commentsEnabled ? "false" : "true",
              }}
              label={p.commentsEnabled ? t("feed.commentsOff") : t("feed.commentsOn")}
              variant="ghost"
              refusals={REFUSALS}
            />
            <ActionButton
              action={postSwitchesAction}
              hidden={{
                org: ctx.org.slug,
                id: p.id,
                reactions: p.reactionsEnabled ? "false" : "true",
              }}
              label={p.reactionsEnabled ? t("feed.reactionsOff") : t("feed.reactionsOn")}
              variant="ghost"
              refusals={REFUSALS}
            />
            <ActionButton
              action={hidePostAction}
              hidden={{ org: ctx.org.slug, id: p.id }}
              label={t("feed.hide")}
              variant="danger"
              reason={t("feed.hideReason")}
              refusals={REFUSALS}
            />
          </>
        ) : null}
      </OverflowMenu>
    );
  };

  // Reactions are the curated glyphs, each with its count only when someone reacted (A59-027).
  const reactions = (p: FeedPost) =>
    p.reactionsEnabled && !p.hiddenAt ? (
      <ReactionBar
        org={ctx.org.slug}
        postId={p.id}
        label={t("feed.reactions")}
        choices={REACTION_CODES.map((code) => ({
          code,
          label: t("feed.reaction", {
            name: t(`feed.reactionNames.${code}`),
            count: p.reactions[code] ?? 0,
          }),
          count: p.reactions[code] ?? 0,
          mine: p.myReactions.includes(code),
        }))}
      />
    ) : null;

  const poll = async (p: FeedPost) => {
    if (!p.poll) return null;
    const voted = p.poll.myChoices.length > 0;
    const closed = p.poll.closesAt !== null && Date.parse(p.poll.closesAt) <= requestNow();
    if (voted || closed) {
      const results = await getPollResults(ctx.viewer.db, p.poll.id);
      if (!results.ok) return <ErrorPanel what={t("feed.pollResults")} />;
      return (
        <ul
          className="m-0 flex list-none flex-col gap-4 p-0 text-text-13"
          aria-label={t("feed.pollResults")}
        >
          {results.data.map((r) => (
            <li key={r.optionId}>
              {t("feed.pollLine", {
                label: r.label,
                votes: r.votes,
                percent: votePercent(r.votes, r.voters),
              })}
              {p.poll?.myChoices.includes(r.optionId) ? ` ${t("feed.yourVote")}` : ""}
            </li>
          ))}
        </ul>
      );
    }
    const options = p.poll.options.map((o) => ({ value: o.id, label: o.label }));
    return (
      <EntityForm
        id={`vote-${p.poll.id}`}
        action={voteAction}
        hidden={{ org: ctx.org.slug, id: p.poll.id }}
        refusals={REFUSALS}
        submitLabel={t("feed.vote")}
        submitVariant="secondary"
        fields={[
          p.poll.allowsMultiple
            ? { kind: "checkboxes", name: "option", label: p.poll.question, options }
            : {
                kind: "select",
                name: "option",
                label: p.poll.question,
                required: true,
                options,
                blankLabel: t("feed.pickOne"),
              },
        ]}
      />
    );
  };

  const card = async (p: FeedPost) => (
    <Card
      key={p.id}
      title={p.title ?? t(`feed.kinds.${p.kind}`)}
      meta={t("feed.byline", {
        name: p.authorName ?? t("someone"),
        date: when(p.publishAt),
        audience: audienceLabel(t, p.audience, pickers),
      })}
    >
      <div className="flex flex-col gap-12">
        {p.pinnedAt ? (
          <span className="text-text-12 font-medium text-text-secondary">
            {t("feed.states.pinned")}
          </span>
        ) : null}
        <p className="m-0 whitespace-pre-wrap text-text-14">{p.body}</p>
        {await poll(p)}
        {p.requiresAcknowledgment ? (
          <p className="m-0 text-text-12 text-text-secondary">
            {p.acknowledgedByMe ? t("feed.acknowledged") : t("feed.needsAcknowledgment")}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-8">
          {reactions(p)}
          <div className="flex flex-wrap items-center gap-8">
            {acknowledge(p)}
            <KitLink href={withQuery(path, state, { view: "feed", peek: p.id })} size="sm">
              {p.commentsEnabled ? t("feed.openComments") : t("feed.open")}
            </KitLink>
            {moreActions(p)}
          </div>
        </div>
      </div>
    </Card>
  );

  let drawer = null;
  if (state.create && canPost) {
    drawer = (
      <FormDrawer title={t("feed.create")} closeHref={withQuery(path, state)}>
        <EntityForm
          id="post-create"
          action={createPostAction}
          hidden={{ org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("feed.post")}
          successHref={withQuery(path, state)}
          fields={[
            {
              kind: "select",
              name: "kind",
              label: t("feed.kind"),
              required: true,
              defaultValue: "Update",
              options: ["Update", "Announcement", "Poll"].map((k) => ({
                value: k,
                label: t(`feed.kinds.${k}`),
              })),
            },
            { kind: "text", name: "title", label: t("feed.headline") },
            { kind: "textarea", name: "body", label: t("feed.body"), required: true, rows: 5 },
            {
              kind: "text",
              name: "question",
              label: t("feed.question"),
              help: t("feed.questionHelp"),
            },
            {
              kind: "textarea",
              name: "options",
              label: t("feed.options"),
              help: t("feed.optionsHelp"),
              rows: 4,
            },
            ...audienceFields(t, pickers, { withDepartments: true }),
            {
              kind: "datetime",
              name: "publishAt",
              label: t("feed.publishAt"),
              help: t("feed.publishAtHelp"),
            },
            {
              kind: "checkboxes",
              name: "switches",
              label: t("feed.switches"),
              options: [
                ...(canAnnounce
                  ? [
                      { value: "pinned", label: t("feed.pinOption") },
                      { value: "requiresAcknowledgment", label: t("feed.ackOption") },
                    ]
                  : []),
                { value: "reactionsEnabled", label: t("feed.reactionsOption") },
                { value: "commentsEnabled", label: t("feed.commentsOption") },
              ],
              defaultValues: ["reactionsEnabled", "commentsEnabled"],
            },
          ]}
        />
        <SwitchesNote t={t} canAnnounce={canAnnounce} />
      </FormDrawer>
    );
  } else if (selected) {
    const status =
      selected.requiresAcknowledgment &&
      (selected.authorMembershipId === ctx.org.membershipId || canModerate || canAnnounce)
        ? await listAcknowledgmentStatus(ctx.viewer.db, selected.id)
        : null;
    drawer = (
      <PeekDrawer
        recordKey={t(`feed.kinds.${selected.kind}`)}
        title={selected.title ?? t(`feed.kinds.${selected.kind}`)}
        state={postState(selected, t)}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id })}
        properties={[
          { label: t("feed.author"), value: selected.authorName ?? t("someone") },
          { label: t("feed.audienceLabel"), value: audienceLabel(t, selected.audience, pickers) },
          { label: t("feed.publishAt"), value: when(selected.publishAt) },
          { label: t("feed.comments"), value: selected.commentsEnabled ? t("on") : t("off") },
        ]}
        actions={
          <>
            {acknowledge(selected)}
            {moreActions(selected)}
          </>
        }
      >
        <p className="m-0 whitespace-pre-wrap text-text-14">{selected.body}</p>
        {selected.hiddenReason ? (
          <InlineAlert tone="warning" title={t("feed.hiddenTitle")}>
            {selected.hiddenReason}
          </InlineAlert>
        ) : null}
        {status ? (
          <KitSection id="post-acks" title={t("feed.acknowledgments")}>
            {!status.ok ? (
              <ErrorPanel what={t("feed.acknowledgments")} />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
                {status.data.map((s) => (
                  <li key={s.membershipId}>
                    {s.acknowledgedAt
                      ? t("feed.ackLine", { name: s.name, date: when(s.acknowledgedAt) })
                      : t("feed.ackOutstanding", { name: s.name })}
                  </li>
                ))}
              </ul>
            )}
          </KitSection>
        ) : null}
        {selected.commentsEnabled && !selected.hiddenAt ? (
          <CollabPanels ctx={ctx} table="app.feed_posts" id={selected.id} />
        ) : (
          <p className="m-0 text-text-13 text-text-secondary">{t("feed.commentsClosed")}</p>
        )}
      </PeekDrawer>
    );
  }

  const empty = canPost ? (
    <EmptyStateLink
      icon="Megaphone"
      sentence={t("feed.empty")}
      actionLabel={t("feed.create")}
      href={createHref}
    />
  ) : (
    <EmptyRefresh icon="Megaphone" sentence={t("feed.emptyRead")} />
  );
  const createButton = canPost ? (
    <KitLink href={createHref} variant="primary">
      {t("feed.create")}
    </KitLink>
  ) : null;

  if (feedView) {
    const cards = await Promise.all(feed.data.map(card));
    return (
      <div className="flex flex-col gap-16">
        <PageHeader
          title={title}
          count={feed.data.length}
          views={
            <div className="flex flex-wrap gap-8">
              {tabs}
              {viewSwitch}
            </div>
          }
          actions={createButton}
        />
        {feed.data.length === 0 ? (
          empty
        ) : (
          <div className="flex max-w-[min(100%,var(--layout-reading))] flex-col gap-12">
            {cards}
          </div>
        )}
        {drawer}
      </div>
    );
  }

  const rows: KitRow[] = feed.data.map((p) => ({
    id: p.id,
    key: t(`feed.kinds.${p.kind}`),
    title: p.title ?? p.body.slice(0, 80),
    state: postState(p, t),
    meta: t("feed.byline", {
      name: p.authorName ?? t("someone"),
      date: when(p.publishAt),
      audience: audienceLabel(t, p.audience, pickers),
    }),
    cells: {
      kind: t(`feed.kinds.${p.kind}`),
      title: p.title ?? p.body.slice(0, 80),
      state: postState(p, t),
      audience: audienceLabel(t, p.audience, pickers),
      author: p.authorName ?? t("someone"),
      published: when(p.publishAt),
      ack: p.requiresAcknowledgment
        ? p.acknowledgedByMe
          ? t("feed.acknowledged")
          : t("feed.needsAcknowledgment")
        : null,
    },
  }));
  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "kind", label: t("feed.kind") },
        { key: "title", label: t("feed.headline"), wrap: true },
        { key: "state", label: t("feed.state"), type: "state" },
        { key: "audience", label: t("feed.audienceLabel") },
        { key: "author", label: t("feed.author") },
        { key: "published", label: t("feed.publishAt") },
        { key: "ack", label: t("feed.acknowledgment") },
      ]}
      rows={rows}
      actions={
        <div className="flex flex-wrap gap-8">
          {tabs}
          {viewSwitch}
          {createButton}
        </div>
      }
      empty={empty}
    >
      {drawer}
    </CollectionView>
  );
}

function SwitchesNote({ t, canAnnounce }: { t: Copy; canAnnounce: boolean }) {
  return (
    <p className="m-0 text-text-12 text-text-secondary">
      {canAnnounce ? t("feed.switchesNote") : t("feed.switchesNoteMember")}
    </p>
  );
}

async function SurveysSection({
  ctx,
  path,
  search,
  t,
  tabs,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
  t: Copy;
  tabs: React.ReactNode;
}) {
  const state = collectionState(search, VIEWS, await orgToday(ctx));
  const [format, surveys, pickers] = await Promise.all([
    getFormatter(),
    listSurveys(ctx.viewer.db, ctx.org.id, [ctx.org.membershipId]),
    orgPickers(ctx),
  ]);
  const title = t("surveys.title");
  if (!surveys.ok) {
    return (
      <>
        <PageHeader title={title} />
        <ErrorPanel what={t("surveys.what")} />
      </>
    );
  }
  const canWrite = ctx.capabilities.has("knowledge.sop.publish");
  const when = (d: string) => format.dateTime(new Date(d), { dateStyle: "medium" });
  const selected = state.peek ? surveys.data.find((s) => s.id === state.peek) : undefined;
  const createHref = withQuery(path, state, { create: "1" });

  let drawer = null;
  if (state.create && canWrite) {
    drawer = (
      <FormDrawer title={t("surveys.create")} closeHref={withQuery(path, state)}>
        <SurveyForm ctx={ctx} t={t} pickers={pickers} successHref={withQuery(path, state)} />
      </FormDrawer>
    );
  } else if (selected) {
    drawer = await surveyPeek(ctx, t, selected, pickers, path, state, canWrite, when);
  }

  const rows: KitRow[] = surveys.data.map((s) => ({
    id: s.id,
    key: t(`surveys.states.${s.state}`),
    title: s.title,
    state: surveyState(s, t),
    meta: s.respondedByMe
      ? t("surveys.responded")
      : s.anonymous
        ? t("surveys.anonymous")
        : t("surveys.named"),
    cells: {
      title: s.title,
      state: surveyState(s, t),
      audience: audienceLabel(t, s.audience, pickers),
      anonymous: s.anonymous ? t("yes") : t("no"),
      questions: s.questions.length,
      mine: s.respondedByMe
        ? t("surveys.responded")
        : s.state === "Open"
          ? t("surveys.notResponded")
          : null,
    },
  }));
  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "title", label: t("surveys.surveyTitle"), wrap: true },
        { key: "state", label: t("feed.state"), type: "state" },
        { key: "audience", label: t("feed.audienceLabel") },
        { key: "anonymous", label: t("surveys.anonymousLabel") },
        { key: "questions", label: t("surveys.questions"), type: "number" },
        { key: "mine", label: t("surveys.mine") },
      ]}
      rows={rows}
      actions={
        <div className="flex flex-wrap gap-8">
          {tabs}
          {canWrite ? (
            <KitLink href={createHref} variant="primary">
              {t("surveys.create")}
            </KitLink>
          ) : null}
        </div>
      }
      empty={
        canWrite ? (
          <EmptyStateLink
            icon="ClipboardList"
            sentence={t("surveys.empty")}
            actionLabel={t("surveys.create")}
            href={createHref}
          />
        ) : (
          <EmptyRefresh icon="ClipboardList" sentence={t("surveys.emptyRead")} />
        )
      }
    >
      {drawer}
    </CollectionView>
  );
}

function SurveyForm({
  ctx,
  t,
  pickers,
  successHref,
}: {
  ctx: OrgContext;
  t: Copy;
  pickers: OrgPickers;
  successHref: string;
}) {
  return (
    <EntityForm
      id="survey-create"
      action={createSurveyAction}
      hidden={{ org: ctx.org.slug }}
      refusals={REFUSALS}
      submitLabel={t("surveys.create")}
      successHref={successHref}
      fields={[
        { kind: "text", name: "title", label: t("surveys.surveyTitle"), required: true },
        { kind: "textarea", name: "description", label: t("surveys.description"), rows: 2 },
        {
          kind: "textarea",
          name: "questions",
          label: t("surveys.questions"),
          required: true,
          rows: 6,
          help: t("surveys.questionsHelp"),
        },
        {
          kind: "number",
          name: "minResponses",
          label: t("surveys.minResponses"),
          defaultValue: "5",
          help: t("surveys.minResponsesHelp"),
        },
        {
          kind: "checkboxes",
          name: "anonymous",
          label: t("surveys.anonymousLabel"),
          options: [{ value: "on", label: t("surveys.anonymousOption") }],
          defaultValues: ["on"],
        },
        ...audienceFields(t, pickers),
      ]}
    />
  );
}

async function surveyPeek(
  ctx: OrgContext,
  t: Copy,
  s: Survey,
  pickers: OrgPickers,
  path: string,
  state: ReturnType<typeof collectionState>,
  canWrite: boolean,
  when: (d: string) => string,
) {
  const manager = canWrite || s.authorMembershipId === ctx.org.membershipId;
  const results =
    manager && s.state !== "Draft" ? await getSurveyResults(ctx.viewer.db, s.id) : null;
  const moves =
    s.state === "Draft"
      ? [{ next: "Open", label: t("surveys.open") }]
      : s.state === "Open"
        ? [{ next: "Closed", label: t("surveys.close"), danger: true }]
        : [];
  return (
    <PeekDrawer
      recordKey={t(`surveys.states.${s.state}`)}
      title={s.title}
      state={surveyState(s, t)}
      closeHref={withQuery(path, state)}
      fullHref={withQuery(path, state, { peek: s.id })}
      properties={[
        { label: t("feed.audienceLabel"), value: audienceLabel(t, s.audience, pickers) },
        {
          label: t("surveys.anonymousLabel"),
          value: s.anonymous ? t("surveys.anonymous") : t("surveys.named"),
        },
        { label: t("surveys.minResponses"), value: String(s.minResponses) },
        { label: t("surveys.created"), value: when(s.createdAt) },
      ]}
      actions={
        manager ? (
          <TransitionButtons
            action={transitionSurveyAction}
            org={ctx.org.slug}
            id={s.id}
            expected={s.state}
            moves={moves}
            refusals={REFUSALS}
          />
        ) : null
      }
    >
      {s.description ? <p className="m-0 text-text-14">{s.description}</p> : null}
      {s.state === "Open" && !s.respondedByMe ? (
        <KitSection id="survey-respond" title={t("surveys.respond")}>
          {s.anonymous ? (
            <p className="m-0 text-text-12 text-text-secondary">{t("surveys.anonymousNote")}</p>
          ) : null}
          <EntityForm
            id={`survey-respond-${s.id}`}
            action={respondSurveyAction}
            hidden={{
              org: ctx.org.slug,
              id: s.id,
              ...Object.fromEntries(s.questions.map((q) => [`kind:${q.id}`, q.kind])),
            }}
            refusals={REFUSALS}
            submitLabel={t("surveys.send")}
            fields={s.questions.map((q) =>
              q.kind === "Text"
                ? {
                    kind: "textarea" as const,
                    name: `q:${q.id}`,
                    label: q.prompt,
                    required: q.required,
                    rows: 3,
                  }
                : {
                    kind: "select" as const,
                    name: `q:${q.id}`,
                    label: q.prompt,
                    required: q.required,
                    blankLabel: t("feed.pickOne"),
                    options:
                      q.kind === "Choice"
                        ? q.choices.map((c) => ({ value: c, label: c }))
                        : Array.from({ length: q.scaleMax ?? 5 }, (_, i) => ({
                            value: String(i + 1),
                            label: String(i + 1),
                          })),
                  },
            )}
          />
        </KitSection>
      ) : s.respondedByMe ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("surveys.thanks")}</p>
      ) : null}
      {results ? (
        <KitSection id="survey-results" title={t("surveys.results")}>
          {!results.ok ? (
            <ErrorPanel what={t("surveys.results")} />
          ) : !results.data.thresholdMet ? (
            <p className="m-0 text-text-13">
              {t("surveys.belowThreshold", {
                responses: results.data.responses,
                needed: results.data.minResponses,
              })}
            </p>
          ) : (
            <div className="flex flex-col gap-12 text-text-13">
              <p className="m-0">
                {t("surveys.rate", {
                  responses: results.data.responses,
                  rate: responseRate(results.data) ?? 0,
                })}
              </p>
              {results.data.questions.map((q) => (
                <div key={q.questionId} className="flex flex-col gap-4">
                  <strong>{q.prompt}</strong>
                  {q.average !== null ? (
                    <span>
                      {t("surveys.average", { average: q.average, max: q.scaleMax ?? 5 })}
                    </span>
                  ) : null}
                  {Object.entries(q.counts).map(([k, v]) => (
                    <span key={k}>{t("surveys.countLine", { answer: k, count: v })}</span>
                  ))}
                  {q.texts.map((x, i) => (
                    <span key={i} className="text-text-secondary">
                      {x}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          )}
        </KitSection>
      ) : null}
    </PeekDrawer>
  );
}
