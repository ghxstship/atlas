import {
  getRecognitionConsent,
  getRecognitionCount,
  listRecognitions,
  type Recognition,
} from "@xos/data/workforce-feed";
import { getFormatter } from "next-intl/server";
import { CollectionView } from "@/components/collection-kit/collection-view";
import {
  ActionButton,
  EmptyRefresh,
  EntityForm,
  ErrorPanel,
  FormDrawer,
  KitLink,
  PeekDrawer,
} from "@/components/collection-kit/kit";
import type { KitRow, ViewKind } from "@/components/collection-kit/types";
import { Card, PageHeader } from "@/components/collection-kit/ui";
import { EmptyStateLink } from "@/components/ui";
import { recognitionConsentAction, recognizeAction } from "@/lib/workforce/actions";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { QuerySwitch } from "./client";
import { REFUSALS, memberOptions, orgPickers, workforceCopy } from "./shared";

const VIEWS: readonly ViewKind[] = ["list", "table"];

/**
 * People > Recognition (Section 4.9 Recognition): shout-outs tied to a project or shift, posted to the
 * feed and sent to the person recognized. There is no points currency. A person's count shows on their
 * profile only when they turn it on here.
 */
export async function RecognitionSection({
  ctx,
  path,
  search,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
}) {
  const feedView = search["view"] === undefined || search["view"] === "feed";
  const state = collectionState(search, VIEWS);
  const person = ctx.viewer.person?.id ?? "";
  const [t, format, list, pickers, consent, count] = await Promise.all([
    workforceCopy(),
    getFormatter(),
    listRecognitions(ctx.viewer.db, ctx.org.id),
    orgPickers(ctx),
    getRecognitionConsent(ctx.viewer.db, ctx.org.id, person),
    getRecognitionCount(ctx.viewer.db, ctx.org.id, person),
  ]);
  const title = t("recognition.title");
  if (!list.ok) {
    return (
      <>
        <PageHeader title={title} />
        <ErrorPanel what={t("recognition.what")} />
      </>
    );
  }
  const canGive = ctx.role !== "viewer";
  const when = (d: string) => format.dateTime(new Date(d), { dateStyle: "medium" });
  const createHref = withQuery(path, state, { create: "1" });
  const consented = consent.ok && consent.data !== null;
  const selected = state.peek ? list.data.find((r) => r.id === state.peek) : undefined;
  const project = (id: string | null) => pickers.projects.find((p) => p.id === id);
  const line = (r: Recognition) =>
    t("recognition.line", {
      from: r.fromName ?? t("someone"),
      to: r.toName ?? t("someone"),
      date: when(r.createdAt),
    });

  const consentPanel = (
    <div className="flex flex-wrap items-center gap-8 text-text-13">
      <span>
        {consented
          ? t("recognition.countShown", { count: count.ok ? (count.data ?? 0) : 0 })
          : t("recognition.countHidden")}
      </span>
      <ActionButton
        action={recognitionConsentAction}
        hidden={{ org: ctx.org.slug, consent: consented ? "false" : "true" }}
        label={consented ? t("recognition.hideCount") : t("recognition.showCount")}
        confirm={{
          title: consented ? t("recognition.hideTitle") : t("recognition.showTitle"),
          body: consented ? t("recognition.hideBody") : t("recognition.showBody"),
        }}
        refusals={REFUSALS}
      />
    </div>
  );

  let drawer = null;
  if (state.create && canGive) {
    drawer = (
      <FormDrawer title={t("recognition.create")} closeHref={withQuery(path, state)}>
        <EntityForm
          id="recognize"
          action={recognizeAction}
          hidden={{ org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("recognition.send")}
          successHref={withQuery(path, state)}
          fields={[
            {
              kind: "select",
              name: "membershipId",
              label: t("recognition.who"),
              required: true,
              blankLabel: t("feed.pickOne"),
              options: memberOptions(pickers.members, ctx.org.membershipId),
            },
            {
              kind: "textarea",
              name: "message",
              label: t("recognition.message"),
              required: true,
              rows: 4,
              help: t("recognition.messageHelp"),
            },
            {
              kind: "select",
              name: "projectId",
              label: t("recognition.project"),
              blankLabel: t("recognition.noProject"),
              options: pickers.projects.map((p) => ({ value: p.id, label: `${p.key} ${p.name}` })),
            },
          ]}
        />
      </FormDrawer>
    );
  } else if (selected) {
    const p = project(selected.projectId);
    drawer = (
      <PeekDrawer
        recordKey={t("recognition.shoutOut")}
        title={selected.toName ?? t("someone")}
        state={{ state: "complete", label: t("recognition.given") }}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id })}
        properties={[
          { label: t("recognition.from"), value: selected.fromName ?? t("someone") },
          {
            label: t("recognition.project"),
            value: p ? `${p.key} ${p.name}` : t("recognition.noProject"),
          },
          { label: t("recognition.date"), value: when(selected.createdAt) },
        ]}
      >
        <p className="m-0 whitespace-pre-wrap text-text-14">{selected.message}</p>
      </PeekDrawer>
    );
  }

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
  const createButton = canGive ? (
    <KitLink href={createHref} variant="primary">
      {t("recognition.create")}
    </KitLink>
  ) : null;
  const empty = canGive ? (
    <EmptyStateLink
      icon="Award"
      sentence={t("recognition.empty")}
      actionLabel={t("recognition.create")}
      href={createHref}
    />
  ) : (
    <EmptyRefresh icon="Award" sentence={t("recognition.emptyRead")} />
  );

  if (feedView) {
    return (
      <div className="flex flex-col gap-16">
        <PageHeader
          title={title}
          count={list.data.length}
          views={viewSwitch}
          actions={createButton}
        />
        {consentPanel}
        {list.data.length === 0 ? (
          empty
        ) : (
          <div className="flex max-w-[min(100%,var(--layout-reading))] flex-col gap-12">
            {list.data.map((r) => (
              <Card key={r.id} title={r.toName ?? t("someone")} meta={line(r)}>
                <p className="m-0 whitespace-pre-wrap text-text-14">{r.message}</p>
              </Card>
            ))}
          </div>
        )}
        {drawer}
      </div>
    );
  }

  const rows: KitRow[] = list.data.map((r) => ({
    id: r.id,
    key: t("recognition.shoutOut"),
    title: r.toName ?? t("someone"),
    state: { state: "complete", label: t("recognition.given") },
    meta: line(r),
    cells: {
      to: r.toName ?? t("someone"),
      from: r.fromName ?? t("someone"),
      message: r.message,
      date: when(r.createdAt),
    },
  }));
  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "to", label: t("recognition.to") },
        { key: "from", label: t("recognition.from") },
        { key: "message", label: t("recognition.message"), wrap: true },
        { key: "date", label: t("recognition.date") },
      ]}
      rows={rows}
      filters={consentPanel}
      actions={
        <div className="flex flex-wrap gap-8">
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
