import {
  getSop,
  hasUnpublishedChanges,
  listSopAcknowledgments,
  listSops,
  listStandardSops,
  nextSopCode,
  sopStanding,
  type Sop,
} from "@xos/data/knowledge";
import { getFormatter } from "next-intl/server";
import {
  acknowledgeSopAction,
  createSopAction,
  deleteSopAction,
  publishSopAction,
  updateSopAction,
} from "@/app/[org]/knowledge/actions";
import { CollabPanels } from "@/components/collection-kit/collab";
import { CollectionView } from "@/components/collection-kit/collection-view";
import { emptyFor } from "@/components/collection-kit/empty";
import {
  ActionButton,
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
import { getCopy, type Copy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { rememberView } from "@/lib/shell/recents";
import { orgToday } from "@/lib/shell/time-zone";

const VIEWS: readonly ViewKind[] = ["list", "table"];
const REFUSALS = "knowledge.refusals";

function standingOf(s: Sop, t: Copy): KitState {
  if (sopStanding(s) === "draft") return { state: "proposed", label: t("sops.draft") };
  if (hasUnpublishedChanges(s)) return { state: "in-review", label: t("sops.changed") };
  return { state: "active", label: t("sops.published") };
}

/**
 * Knowledge > SOPs: standard operating procedures in code order. Publishing raises the version and
 * asks everyone to acknowledge it again; each person acknowledges only for themselves, and editors
 * see who has. A save over someone else's newer save is refused, so no edit is lost silently.
 */
export async function SopsSection({
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
  const me = ctx.viewer.person?.id ?? null;
  const [t, format, sops] = await Promise.all([
    getCopy("knowledge"),
    getFormatter(),
    listSops(db, ctx.org.id, me),
  ]);
  const title = t("sops.title");
  if (!sops.ok) {
    return (
      <>
        <PageHeader title={title} />
        <ErrorPanel what={t("sops.what")} />
      </>
    );
  }
  const canWrite = ctx.capabilities.has("knowledge.sop.write");
  const canPublish = ctx.capabilities.has("knowledge.sop.publish");
  const when = (d: string) => format.dateTime(new Date(d), { dateStyle: "medium" });
  const selected = state.peek ? sops.data.find((s) => s.id === state.peek) : undefined;
  // The command menu's recent items (Section 11.7).
  if (selected) await rememberView(ctx, "sops", selected.id);
  const properties = (s: Sop) => [
    {
      label: t("sops.version"),
      value: s.publishedAt ? String(s.version) : t("sops.unpublishedVersion"),
    },
    {
      label: t("sops.publishedAt"),
      value: s.publishedAt ? when(s.publishedAt) : t("sops.notPublished"),
    },
    { label: t("sops.acknowledgments"), value: String(s.currentAcknowledgments) },
    {
      label: t("sops.mine"),
      value:
        s.publishedAt === null
          ? t("sops.nothingToAcknowledge")
          : s.acknowledgedByMe
            ? t("sops.acknowledged")
            : t("sops.notAcknowledged"),
    },
  ];
  const actions = (s: Sop) => (
    <>
      {s.publishedAt !== null && !s.acknowledgedByMe && me ? (
        <ActionButton
          action={acknowledgeSopAction}
          hidden={{ org: ctx.org.slug, id: s.id }}
          label={t("sops.acknowledge")}
          variant="primary"
          confirm={{
            title: t("sops.acknowledgeTitle", { code: s.code }),
            body: t("sops.acknowledgeBody", { version: s.version }),
          }}
          refusals={REFUSALS}
        />
      ) : null}
      {canPublish && (s.publishedAt === null || hasUnpublishedChanges(s)) ? (
        <ActionButton
          action={publishSopAction}
          hidden={{ org: ctx.org.slug, id: s.id }}
          label={t("sops.publish")}
          confirm={{ title: t("sops.publishTitle", { code: s.code }), body: t("sops.publishBody") }}
          refusals={REFUSALS}
        />
      ) : null}
      {canWrite ? (
        <ActionButton
          action={deleteSopAction}
          hidden={{ org: ctx.org.slug, id: s.id }}
          label={t("sops.delete")}
          variant="danger"
          confirm={{ title: t("sops.deleteTitle", { code: s.code }), body: t("sops.deleteBody") }}
          refusals={REFUSALS}
        />
      ) : null}
    </>
  );
  const body = (s: Sop) => (
    <div className="flex flex-col gap-12 max-w-[min(100%,var(--layout-reading))]">
      {s.body.split(/\n{2,}/).map((para, i) => (
        <p key={i} className="m-0 whitespace-pre-wrap text-text-14 leading-relaxed">
          {para}
        </p>
      ))}
    </div>
  );

  if (selected && state.full) {
    const [fresh, acks] = await Promise.all([
      getSop(db, selected.id, me),
      listSopAcknowledgments(db, selected.id),
    ]);
    const sop = fresh.ok ? fresh.data : selected;
    return (
      <RecordPage
        backHref={withQuery(path, state)}
        backLabel={t("sops.back")}
        recordKey={sop.code}
        title={sop.title}
        state={standingOf(sop, t)}
        properties={properties(sop)}
        actions={actions(sop)}
      >
        {hasUnpublishedChanges(sop) ? (
          <InlineAlert tone="info" title={t("sops.changedTitle")}>
            {t("sops.changedBody")}
          </InlineAlert>
        ) : null}
        <KitSection id="sop-body" title={t("sops.procedure")}>
          {body(sop)}
        </KitSection>
        {canWrite ? (
          <KitSection id="sop-edit" title={t("sops.edit")}>
            <EntityForm
              id={`sop-edit-${sop.id}`}
              action={updateSopAction}
              hidden={{ org: ctx.org.slug, id: sop.id, expectedUpdatedAt: sop.updatedAt }}
              refusals={REFUSALS}
              submitLabel={t("sops.save")}
              fields={[
                {
                  kind: "text",
                  name: "title",
                  label: t("sops.sopTitle"),
                  required: true,
                  defaultValue: sop.title,
                },
                {
                  kind: "textarea",
                  name: "body",
                  label: t("sops.procedure"),
                  required: true,
                  rows: 12,
                  defaultValue: sop.body,
                  help: t("sops.bodyHelp"),
                },
              ]}
            />
          </KitSection>
        ) : null}
        <KitSection id="sop-acks" title={t("sops.acknowledgmentsTitle")}>
          {!acks.ok ? (
            <ErrorPanel what={t("sops.acknowledgmentsTitle")} />
          ) : acks.data.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("sops.noAcknowledgments")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
              {acks.data.map((a) => (
                <li key={`${a.personId}-${a.version}`}>
                  {t("sops.ackLine", {
                    name: a.personName ?? t("sops.someone"),
                    version: a.version,
                    date: when(a.acknowledgedAt),
                  })}
                </li>
              ))}
            </ul>
          )}
        </KitSection>
        <CollabPanels ctx={ctx} table="app.sops" id={sop.id} />
      </RecordPage>
    );
  }

  const rows: KitRow[] = sops.data.map((s) => ({
    id: s.id,
    key: s.code,
    title: s.title,
    state: standingOf(s, t),
    meta: s.publishedAt
      ? t("sops.versionLine", { version: s.version, date: when(s.publishedAt) })
      : t("sops.draft"),
    cells: {
      code: s.code,
      title: s.title,
      state: standingOf(s, t),
      version: s.publishedAt ? s.version : null,
      acks: s.currentAcknowledgments,
      mine:
        s.publishedAt === null
          ? null
          : s.acknowledgedByMe
            ? t("sops.acknowledged")
            : t("sops.notAcknowledged"),
    },
  }));

  let drawer = null;
  if (state.create && canWrite) {
    const standard = await listStandardSops(db);
    const from = typeof search["from"] === "string" ? search["from"] : "";
    const chosen = standard.ok ? standard.data.find((s) => s.id === from) : undefined;
    drawer = (
      <FormDrawer title={t("sops.create")} closeHref={withQuery(path, state)}>
        {standard.ok && standard.data.length > 0 ? (
          <form method="get" action={path} className="flex flex-wrap items-end gap-8">
            <input type="hidden" name="create" value="1" />
            <div className="flex flex-col gap-4">
              <label htmlFor="sop-from" className="text-label-13 font-medium">
                {t("sops.startFrom")}
              </label>
              <select
                id="sop-from"
                name="from"
                defaultValue={from}
                className="h-control-md max-w-full rounded-control border border-border-control bg-bg-surface px-8 text-text-13"
              >
                <option value="">{t("sops.blank")}</option>
                {standard.data.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id} {s.title}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="submit"
              className="h-control-md rounded-control border border-border-control bg-bg-surface px-12 text-text-13 font-medium"
            >
              {t("sops.useTemplate")}
            </button>
          </form>
        ) : null}
        <EntityForm
          id="sop-create"
          action={createSopAction}
          hidden={{ org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("sops.create")}
          successHref={withQuery(path, state, { peek: "{id}" })}
          fields={[
            {
              kind: "text",
              name: "code",
              label: t("sops.code"),
              required: true,
              help: t("sops.codeHelp"),
              defaultValue: nextSopCode(sops.data.map((s) => s.code)),
            },
            {
              kind: "text",
              name: "title",
              label: t("sops.sopTitle"),
              required: true,
              defaultValue: chosen?.title ?? "",
            },
            {
              kind: "textarea",
              name: "body",
              label: t("sops.procedure"),
              required: true,
              rows: 10,
              defaultValue: chosen?.body ?? "",
              help: t("sops.bodyHelp"),
            },
          ]}
        />
      </FormDrawer>
    );
  } else if (selected) {
    drawer = (
      <PeekDrawer
        recordKey={selected.code}
        title={selected.title}
        state={standingOf(selected, t)}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id, full: "1" })}
        properties={properties(selected)}
        actions={actions(selected)}
      >
        {body(selected)}
      </PeekDrawer>
    );
  }

  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "code", label: t("sops.code"), type: "code" },
        { key: "title", label: t("sops.sopTitle"), wrap: true },
        { key: "state", label: t("sops.standing"), type: "state" },
        { key: "version", label: t("sops.version"), type: "number" },
        { key: "acks", label: t("sops.acknowledgments"), type: "number" },
        { key: "mine", label: t("sops.mine") },
      ]}
      rows={rows}
      actions={
        canWrite ? (
          <KitLink href={withQuery(path, state, { create: "1" })} variant="primary">
            {t("sops.create")}
          </KitLink>
        ) : null
      }
      empty={emptyFor(t, canWrite, withQuery(path, state, { create: "1" }), "sops")}
    >
      {drawer}
    </CollectionView>
  );
}
