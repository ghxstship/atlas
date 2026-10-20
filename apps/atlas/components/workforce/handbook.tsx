import {
  handbookChanged,
  listHandbookAcknowledgmentStatus,
  listHandbookArticles,
  listHandbookSections,
  type HandbookArticle,
} from "@xos/data/workforce-training";
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
  RecordPage,
} from "@/components/collection-kit/kit";
import type { KitRow, KitState, ViewKind } from "@/components/collection-kit/types";
import { InlineAlert, PageHeader } from "@/components/collection-kit/ui";
import { EmptyStateLink } from "@/components/ui";
import {
  acknowledgeArticleAction,
  archiveArticleAction,
  createSectionAction,
  publishArticleAction,
  saveArticleAction,
} from "@/lib/workforce/actions";
import type { Copy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import { REFUSALS, workforceCopy } from "./shared";

const VIEWS: readonly ViewKind[] = ["list", "table"];

function articleState(a: HandbookArticle, t: Copy): KitState {
  if (a.state === "Archived") return { state: "canceled", label: t("handbook.states.Archived") };
  if (a.state === "Draft") return { state: "proposed", label: t("handbook.states.Draft") };
  if (handbookChanged(a)) return { state: "in-review", label: t("handbook.states.Changed") };
  return { state: "active", label: t("handbook.states.Published") };
}

/**
 * Knowledge > Handbook (Section 4.9 Handbook and SOPs): a searchable library of articles in sections.
 * Members read the published version; editors work on the next one, and publishing a mandatory
 * article asks everyone to acknowledge the new version. Publishers see who has.
 */
export async function HandbookSection({
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
  const [t, format, articles, sections] = await Promise.all([
    workforceCopy(),
    getFormatter(),
    listHandbookArticles(db, ctx.org.id, [ctx.org.membershipId]),
    listHandbookSections(db, ctx.org.id),
  ]);
  const title = t("handbook.title");
  if (!articles.ok || !sections.ok) {
    return (
      <>
        <PageHeader title={title} />
        <ErrorPanel what={t("handbook.what")} />
      </>
    );
  }
  const canWrite = ctx.capabilities.has("knowledge.sop.write");
  const canPublish = ctx.capabilities.has("knowledge.sop.publish");
  const when = (d: string) => format.dateTime(new Date(d), { dateStyle: "medium" });
  const sectionName = (id: string | null) =>
    sections.data.find((s) => s.id === id)?.name ?? t("handbook.noSection");
  const visible = canWrite ? articles.data : articles.data.filter((a) => a.state === "Published");
  const selected = state.peek ? visible.find((a) => a.id === state.peek) : undefined;
  const outstanding = visible.filter(
    (a) => a.mandatory && a.state === "Published" && !a.acknowledgedByMe,
  );

  const properties = (a: HandbookArticle) => [
    { label: t("handbook.section"), value: sectionName(a.sectionId) },
    {
      label: t("handbook.version"),
      value: a.version > 0 ? String(a.version) : t("handbook.unpublished"),
    },
    {
      label: t("handbook.publishedAt"),
      value: a.publishedAt ? when(a.publishedAt) : t("handbook.notPublished"),
    },
    { label: t("handbook.mandatory"), value: a.mandatory ? t("yes") : t("no") },
    {
      label: t("handbook.mine"),
      value:
        !a.mandatory || a.state !== "Published"
          ? t("handbook.nothingToAcknowledge")
          : a.acknowledgedByMe
            ? t("handbook.acknowledged")
            : t("handbook.notAcknowledged"),
    },
  ];
  const actions = (a: HandbookArticle) => (
    <>
      {a.mandatory && a.state === "Published" && !a.acknowledgedByMe ? (
        <ActionButton
          action={acknowledgeArticleAction}
          hidden={{ org: ctx.org.slug, id: a.id }}
          label={t("handbook.acknowledge")}
          variant="primary"
          confirm={{
            title: t("handbook.acknowledgeTitle", { title: a.title }),
            body: t("handbook.acknowledgeBody", { version: a.version }),
          }}
          refusals={REFUSALS}
        />
      ) : null}
      {canPublish && a.state !== "Archived" && handbookChanged(a) ? (
        <ActionButton
          action={publishArticleAction}
          hidden={{ org: ctx.org.slug, id: a.id }}
          label={t("handbook.publish")}
          confirm={{
            title: t("handbook.publishTitle", { title: a.title }),
            body: a.mandatory ? t("handbook.publishMandatory") : t("handbook.publishBody"),
          }}
          refusals={REFUSALS}
        />
      ) : null}
      {canPublish && a.state === "Published" ? (
        <ActionButton
          action={archiveArticleAction}
          hidden={{ org: ctx.org.slug, id: a.id }}
          label={t("handbook.archive")}
          variant="danger"
          confirm={{
            title: t("handbook.archiveTitle", { title: a.title }),
            body: t("handbook.archiveBody"),
          }}
          refusals={REFUSALS}
        />
      ) : null}
    </>
  );
  const body = (text: string) => (
    <div className="flex max-w-[min(100%,var(--layout-reading))] flex-col gap-12">
      {text.split(/\n{2,}/).map((para, i) => (
        <p key={i} className="m-0 whitespace-pre-wrap text-text-14 leading-relaxed">
          {para}
        </p>
      ))}
    </div>
  );
  const articleFields = (a?: HandbookArticle) => [
    {
      kind: "text" as const,
      name: "title",
      label: t("handbook.articleTitle"),
      required: true,
      defaultValue: a?.title ?? "",
    },
    {
      kind: "select" as const,
      name: "sectionId",
      label: t("handbook.section"),
      blankLabel: t("handbook.noSection"),
      defaultValue: a?.sectionId ?? "",
      options: sections.data.map((s) => ({ value: s.id, label: s.name })),
    },
    {
      kind: "textarea" as const,
      name: "body",
      label: t("handbook.body"),
      required: true,
      rows: 12,
      defaultValue: a?.body ?? "",
      help: t("handbook.bodyHelp"),
    },
    {
      kind: "checkboxes" as const,
      name: "mandatory",
      label: t("handbook.mandatory"),
      options: [{ value: "on", label: t("handbook.mandatoryOption") }],
      defaultValues: a?.mandatory ? ["on"] : [],
    },
  ];

  if (selected && state.full) {
    const acks =
      canPublish && selected.mandatory && selected.state === "Published"
        ? await listHandbookAcknowledgmentStatus(db, selected.id)
        : null;
    return (
      <RecordPage
        backHref={withQuery(path, state)}
        backLabel={t("handbook.back")}
        recordKey={sectionName(selected.sectionId)}
        title={selected.published?.title ?? selected.title}
        state={articleState(selected, t)}
        properties={properties(selected)}
        actions={actions(selected)}
      >
        {canWrite && handbookChanged(selected) && selected.state !== "Draft" ? (
          <InlineAlert tone="info" title={t("handbook.changedTitle")}>
            {t("handbook.changedBody")}
          </InlineAlert>
        ) : null}
        <KitSection id="article-body" title={t("handbook.published")}>
          {selected.published ? (
            body(selected.published.body)
          ) : (
            <p className="m-0 text-text-13 text-text-secondary">{t("handbook.notPublished")}</p>
          )}
        </KitSection>
        {canWrite && selected.state !== "Archived" ? (
          <KitSection id="article-edit" title={t("handbook.edit")}>
            <EntityForm
              id={`article-edit-${selected.id}`}
              action={saveArticleAction}
              hidden={{ org: ctx.org.slug, id: selected.id }}
              refusals={REFUSALS}
              submitLabel={t("handbook.save")}
              fields={articleFields(selected)}
            />
          </KitSection>
        ) : null}
        {acks ? (
          <KitSection id="article-acks" title={t("handbook.acknowledgments")}>
            {!acks.ok ? (
              <ErrorPanel what={t("handbook.acknowledgments")} />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
                {acks.data.map((x) => (
                  <li key={x.membershipId}>
                    {x.acknowledgedAt
                      ? t("feed.ackLine", { name: x.name, date: when(x.acknowledgedAt) })
                      : t("feed.ackOutstanding", { name: x.name })}
                  </li>
                ))}
              </ul>
            )}
          </KitSection>
        ) : null}
        <CollabPanels ctx={ctx} table="app.handbook_articles" id={selected.id} />
      </RecordPage>
    );
  }

  let drawer = null;
  if (state.create && canWrite) {
    drawer = (
      <FormDrawer title={t("handbook.create")} closeHref={withQuery(path, state)}>
        <EntityForm
          id="article-create"
          action={saveArticleAction}
          hidden={{ org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("handbook.create")}
          successHref={withQuery(path, state, { peek: "{id}", full: "1" })}
          fields={articleFields()}
        />
        <KitSection id="section-create" title={t("handbook.newSection")}>
          <EntityForm
            id="section-create-form"
            action={createSectionAction}
            hidden={{ org: ctx.org.slug }}
            refusals={REFUSALS}
            submitLabel={t("handbook.addSection")}
            fields={[
              { kind: "text", name: "name", label: t("handbook.sectionName"), required: true },
              {
                kind: "number",
                name: "position",
                label: t("handbook.position"),
                defaultValue: String(sections.data.length + 1),
              },
            ]}
          />
        </KitSection>
      </FormDrawer>
    );
  } else if (selected) {
    drawer = (
      <PeekDrawer
        recordKey={sectionName(selected.sectionId)}
        title={selected.published?.title ?? selected.title}
        state={articleState(selected, t)}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id, full: "1" })}
        properties={properties(selected)}
        actions={actions(selected)}
      >
        {selected.published ? body(selected.published.body) : body(selected.body)}
      </PeekDrawer>
    );
  }

  const rows: KitRow[] = visible.map((a) => ({
    id: a.id,
    key: sectionName(a.sectionId),
    title: a.published?.title ?? a.title,
    state: articleState(a, t),
    meta: a.mandatory
      ? a.acknowledgedByMe
        ? t("handbook.acknowledged")
        : t("handbook.mandatoryRead")
      : t("handbook.versionLine", { version: a.version }),
    cells: {
      section: sectionName(a.sectionId),
      title: a.published?.title ?? a.title,
      state: articleState(a, t),
      version: a.version > 0 ? a.version : null,
      mandatory: a.mandatory ? t("yes") : t("no"),
      mine:
        a.mandatory && a.state === "Published"
          ? a.acknowledgedByMe
            ? t("handbook.acknowledged")
            : t("handbook.notAcknowledged")
          : null,
      body: a.published?.body.slice(0, 200) ?? "",
    },
  }));
  const createHref = withQuery(path, state, { create: "1" });
  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "section", label: t("handbook.section") },
        { key: "title", label: t("handbook.articleTitle"), wrap: true },
        { key: "state", label: t("feed.state"), type: "state" },
        { key: "version", label: t("handbook.version"), type: "number" },
        { key: "mandatory", label: t("handbook.mandatory") },
        { key: "mine", label: t("handbook.mine") },
      ]}
      rows={rows}
      filters={
        outstanding.length > 0 ? (
          <InlineAlert
            tone="info"
            title={t("handbook.outstandingTitle", { count: outstanding.length })}
          >
            {outstanding.map((a) => a.published?.title ?? a.title).join(", ")}
          </InlineAlert>
        ) : undefined
      }
      actions={
        canWrite ? (
          <KitLink href={createHref} variant="primary">
            {t("handbook.create")}
          </KitLink>
        ) : null
      }
      empty={
        canWrite ? (
          <EmptyStateLink
            icon="BookOpen"
            sentence={t("handbook.empty")}
            actionLabel={t("handbook.create")}
            href={createHref}
          />
        ) : (
          <EmptyRefresh icon="BookOpen" sentence={t("handbook.emptyRead")} />
        )
      }
    >
      {drawer}
    </CollectionView>
  );
}
