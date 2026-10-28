import {
  listCanonExtensionProposals,
  listDepartments,
  listDisciplines,
  type CanonExtensionProposal,
  type CanonExtensionState,
} from "@xos/data/canon";
import { nextStates } from "@xos/data/commercial-common";
import { listTransitionRules } from "@xos/data/vendors";
import { getFormatter } from "next-intl/server";
import {
  decideExtensionAction,
  proposeExtensionAction,
  updateExtensionAction,
} from "@/app/[org]/canon/actions";
import { CollabPanels } from "@/components/collection-kit/collab";
import { CollectionView } from "@/components/collection-kit/collection-view";
import { emptyFor } from "@/components/collection-kit/empty";
import { StateHistory } from "@/components/collection-kit/history";
import {
  EntityForm,
  ErrorPanel,
  FormDrawer,
  KitLink,
  KitSection,
  PeekDrawer,
  RecordPage,
  TransitionButtons,
} from "@/components/collection-kit/kit";
import type { KitRow, KitState, ViewKind } from "@/components/collection-kit/types";
import { InlineAlert, PageHeader } from "@/components/collection-kit/ui";
import { getCopy, type Copy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import * as enums from "@xos/data/enums";

const VIEWS: readonly ViewKind[] = ["table", "list", "board"];
const REFUSALS = "canonBrowser.refusals";
const RECORD_STATE: Record<CanonExtensionState, KitState["state"]> = {
  Proposed: "in-review",
  Approved: "complete",
  Rejected: "canceled",
  Withdrawn: "canceled",
};

function stateOf(p: CanonExtensionProposal, t: Copy): KitState {
  return { state: RECORD_STATE[p.state], label: t(`extensions.states.${p.state}`) };
}

/**
 * Canon > Org extensions: the org's own disciplines and categories in the adopter range .50 to .99.
 * Owners and Admins propose them; someone other than the proposer approves or rejects; an approved
 * proposal is the org's extension and shows beside canon. Canon itself is never written.
 */
export async function CanonExtensions({
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
  const [t, format, proposals, departments, disciplines, rules] = await Promise.all([
    getCopy("canonBrowser"),
    getFormatter(),
    listCanonExtensionProposals(db, ctx.org.id),
    listDepartments(db),
    listDisciplines(db),
    listTransitionRules<CanonExtensionState>(db, "canon_extension"),
  ]);
  const title = t("extensions.title");
  if (!proposals.ok || !departments.ok || !disciplines.ok || !rules.ok) {
    return (
      <>
        <PageHeader title={title} />
        <ErrorPanel what={t("extensions.what")} />
      </>
    );
  }
  const canWrite = ctx.capabilities.has("canon.extension.write");
  const me = ctx.viewer.person?.id ?? null;
  const when = (d: string) => format.dateTime(new Date(d), { dateStyle: "medium" });
  const selected = state.peek ? proposals.data.find((p) => p.id === state.peek) : undefined;
  const properties = (p: CanonExtensionProposal) => [
    { label: t("extensions.level"), value: t(`extensions.levels.${p.level}`) },
    { label: t("extensions.parent"), value: p.parentCode },
    { label: t("extensions.proposed"), value: when(p.createdAt) },
    {
      label: t("extensions.decided"),
      value: p.decidedAt ? when(p.decidedAt) : t("extensions.notDecided"),
    },
  ];
  const moves = (p: CanonExtensionProposal) =>
    canWrite ? (
      <TransitionButtons
        action={decideExtensionAction}
        org={ctx.org.slug}
        id={p.id}
        expected={p.state}
        refusals={REFUSALS}
        moves={nextStates(rules.data, p.state)
          .filter((next) => next === "Withdrawn" || p.createdBy !== me)
          .map((next) => ({
            next,
            label: t(`extensions.moves.${next}`),
            danger: next !== "Approved",
          }))}
      />
    ) : null;
  const notice = (p: CanonExtensionProposal) =>
    p.state === "Proposed" && p.createdBy === me ? (
      <InlineAlert tone="info">{t("extensions.ownProposal")}</InlineAlert>
    ) : null;

  if (selected && state.full) {
    return (
      <RecordPage
        backHref={withQuery(path, state)}
        backLabel={t("back", { page: title })}
        recordKey={selected.proposedCode}
        title={selected.label}
        state={stateOf(selected, t)}
        properties={properties(selected)}
        actions={moves(selected)}
      >
        {notice(selected)}
        <KitSection id="extension-rationale" title={t("extensions.rationale")}>
          <p className="m-0 whitespace-pre-wrap">{selected.rationale}</p>
        </KitSection>
        {canWrite && selected.state === "Proposed" ? (
          <KitSection id="extension-edit" title={t("extensions.edit")}>
            <EntityForm
              id={`extension-edit-${selected.id}`}
              action={updateExtensionAction}
              hidden={{ org: ctx.org.slug, id: selected.id }}
              refusals={REFUSALS}
              submitLabel={t("extensions.save")}
              fields={[
                {
                  kind: "text",
                  name: "label",
                  label: t("extensions.label"),
                  required: true,
                  defaultValue: selected.label,
                },
                {
                  kind: "textarea",
                  name: "rationale",
                  label: t("extensions.rationale"),
                  required: true,
                  defaultValue: selected.rationale,
                },
              ]}
            />
          </KitSection>
        ) : null}
        <StateHistory
          ctx={ctx}
          ledger="canon_extension"
          id={selected.id}
          stateLabel={(s) => t(`extensions.states.${s}`)}
        />
        <CollabPanels ctx={ctx} table="app.canon_extension_proposals" id={selected.id} />
      </RecordPage>
    );
  }

  const rows: KitRow[] = proposals.data.map((p) => ({
    id: p.id,
    key: p.proposedCode,
    title: p.label,
    state: stateOf(p, t),
    boardValue: p.state,
    meta: t(`extensions.levels.${p.level}`),
    cells: {
      code: p.proposedCode,
      label: p.label,
      level: t(`extensions.levels.${p.level}`),
      parent: p.parentCode,
      state: stateOf(p, t),
    },
  }));

  let drawer = null;
  if (state.create && canWrite) {
    const approvedDisciplines = proposals.data.filter(
      (p) => p.state === "Approved" && p.level === "Discipline",
    );
    drawer = (
      <FormDrawer title={t("extensions.create")} closeHref={withQuery(path, state)}>
        <p className="m-0 text-text-13 text-text-secondary">{t("extensions.createHelp")}</p>
        <EntityForm
          id="extension-create"
          action={proposeExtensionAction}
          hidden={{ org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("extensions.create")}
          successHref={withQuery(path, state, { peek: "{id}" })}
          fields={[
            {
              kind: "select",
              name: "level",
              label: t("extensions.level"),
              defaultValue: "Discipline",
              options: [
                { value: "Discipline", label: t("extensions.levels.Discipline") },
                { value: "Category", label: t("extensions.levels.Category") },
              ],
            },
            {
              kind: "select",
              name: "parentCode",
              label: t("extensions.parent"),
              help: t("extensions.parentHelp"),
              blankLabel: t("extensions.chooseParent"),
              defaultValue: "",
              options: [
                ...departments.data.map((d) => ({
                  value: d.code,
                  label: `${d.code} ${d.name} (${t("extensions.levels.Department")})`,
                })),
                ...disciplines.data.map((d) => ({ value: d.code, label: `${d.code} ${d.name}` })),
                ...approvedDisciplines.map((d) => ({
                  value: d.proposedCode,
                  label: `${d.proposedCode} ${d.label} (${t("orgExtension")})`,
                })),
              ],
            },
            {
              kind: "text",
              name: "proposedCode",
              label: t("extensions.code"),
              required: true,
              help: t("extensions.codeHelp"),
            },
            {
              kind: "text",
              name: "label",
              label: t("extensions.label"),
              required: true,
              help: t("extensions.labelHelp"),
            },
            {
              kind: "textarea",
              name: "rationale",
              label: t("extensions.rationale"),
              required: true,
            },
          ]}
        />
      </FormDrawer>
    );
  } else if (selected) {
    drawer = (
      <PeekDrawer
        recordKey={selected.proposedCode}
        title={selected.label}
        state={stateOf(selected, t)}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id, full: "1" })}
        properties={properties(selected)}
        actions={moves(selected)}
      >
        {notice(selected)}
        <p className="m-0 whitespace-pre-wrap text-text-13">{selected.rationale}</p>
      </PeekDrawer>
    );
  }

  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "code", label: t("extensions.code"), type: "code" },
        { key: "label", label: t("extensions.label") },
        { key: "level", label: t("extensions.level") },
        { key: "parent", label: t("extensions.parent"), type: "code" },
        { key: "state", label: t("fields.state"), type: "state" },
      ]}
      rows={rows}
      board={enums.canonExtensionState.map((s) => ({
        value: s,
        state: RECORD_STATE[s],
        label: t(`extensions.states.${s}`),
      }))}
      actions={
        canWrite ? (
          <KitLink href={withQuery(path, state, { create: "1" })} variant="primary">
            {t("extensions.create")}
          </KitLink>
        ) : null
      }
      empty={emptyFor(t, canWrite, withQuery(path, state, { create: "1" }), "extensions")}
    >
      {drawer}
    </CollectionView>
  );
}
