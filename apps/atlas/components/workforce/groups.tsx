import { listGroupMembers, listGroups, GROUP_KINDS, type Group } from "@xos/data/workforce-chat";
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
} from "@/components/collection-kit/kit";
import type { KitRow, KitState, ViewKind } from "@/components/collection-kit/types";
import { PageHeader } from "@/components/collection-kit/ui";
import { EmptyStateLink } from "@/components/ui";
import {
  addGroupMemberAction,
  archiveGroupAction,
  createGroupAction,
  removeGroupMemberAction,
} from "@/lib/workforce/actions";
import type { Copy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import { nodeHref } from "@/lib/shell/sitemap";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import { REFUSALS, memberOptions, orgPickers, workforceCopy } from "./shared";

const VIEWS: readonly ViewKind[] = ["list", "table"];

function groupState(g: Group, t: Copy): KitState {
  return g.archivedAt
    ? { state: "canceled", label: t("groups.archived") }
    : { state: "active", label: t("groups.active") };
}

/**
 * People > Groups (Section 4.9 Groups): spaces by department, project, crew or custom audience, each
 * with its own conversation and files. Communication admins create and archive groups; owners add and
 * remove members. Members see their own groups.
 */
export async function GroupsSection({
  ctx,
  path,
  search,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
}) {
  const state = collectionState(search, VIEWS, await orgToday(ctx));
  const [t, groups, pickers] = await Promise.all([
    workforceCopy(),
    listGroups(ctx.viewer.db, ctx.org.id),
    orgPickers(ctx),
  ]);
  const title = t("groups.title");
  if (!groups.ok) {
    return (
      <>
        <PageHeader title={title} />
        <ErrorPanel what={t("groups.what")} />
      </>
    );
  }
  const canManage = ctx.capabilities.has("org.communication.write");
  const selected = state.peek ? groups.data.find((g) => g.id === state.peek) : undefined;
  const chatHref = nodeHref("people.chat", { org: ctx.org.slug }) ?? "/";
  const createHref = withQuery(path, state, { create: "1" });
  const projectName = (id: string | null) => pickers.projects.find((p) => p.id === id);

  let drawer = null;
  if (state.create && canManage) {
    drawer = (
      <FormDrawer title={t("groups.create")} closeHref={withQuery(path, state)}>
        <EntityForm
          id="group-create"
          action={createGroupAction}
          hidden={{ org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("groups.create")}
          successHref={withQuery(path, state, { peek: "{id}" })}
          fields={[
            { kind: "text", name: "name", label: t("groups.name"), required: true },
            {
              kind: "select",
              name: "kind",
              label: t("groups.kind"),
              required: true,
              defaultValue: "Crew",
              options: GROUP_KINDS.map((k) => ({ value: k, label: t(`groups.kinds.${k}`) })),
            },
            {
              kind: "select",
              name: "projectId",
              label: t("groups.project"),
              help: t("groups.projectHelp"),
              blankLabel: t("groups.noProject"),
              options: pickers.projects.map((p) => ({ value: p.id, label: `${p.key} ${p.name}` })),
            },
            { kind: "textarea", name: "description", label: t("groups.description"), rows: 3 },
          ]}
        />
      </FormDrawer>
    );
  } else if (selected) {
    const members = await listGroupMembers(ctx.viewer.db, selected.id);
    const owner =
      members.ok &&
      members.data.some((m) => m.membershipId === ctx.org.membershipId && m.role === "Owner");
    const canEditMembers = (canManage || owner) && !selected.archivedAt;
    const project = projectName(selected.projectId);
    drawer = (
      <PeekDrawer
        recordKey={t(`groups.kinds.${selected.kind}`)}
        title={selected.name}
        state={groupState(selected, t)}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id })}
        properties={[
          { label: t("groups.members"), value: String(selected.memberCount) },
          {
            label: t("groups.project"),
            value: project ? `${project.key} ${project.name}` : t("groups.noProject"),
          },
        ]}
        actions={
          <>
            <KitLink href={chatHref} variant="primary" size="sm">
              {t("groups.openChat")}
            </KitLink>
            {canManage && !selected.archivedAt ? (
              <ActionButton
                action={archiveGroupAction}
                hidden={{ org: ctx.org.slug, id: selected.id }}
                label={t("groups.archive")}
                variant="danger"
                confirm={{
                  title: t("groups.archiveTitle", { name: selected.name }),
                  body: t("groups.archiveBody"),
                }}
                refusals={REFUSALS}
              />
            ) : null}
          </>
        }
      >
        {selected.description ? <p className="m-0 text-text-14">{selected.description}</p> : null}
        <KitSection id="group-members" title={t("groups.members")}>
          {!members.ok ? (
            <ErrorPanel what={t("groups.members")} />
          ) : members.data.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("groups.noMembers")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-8 p-0 text-text-13">
              {members.data.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-8">
                  <span>
                    {m.name ?? t("someone")} {m.role === "Owner" ? `(${t("groups.owner")})` : ""}
                  </span>
                  {canEditMembers ? (
                    <ActionButton
                      action={removeGroupMemberAction}
                      hidden={{ org: ctx.org.slug, id: m.id }}
                      label={t("groups.remove")}
                      refusals={REFUSALS}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {canEditMembers ? (
            <EntityForm
              id={`group-add-${selected.id}`}
              action={addGroupMemberAction}
              hidden={{ org: ctx.org.slug, id: selected.id }}
              refusals={REFUSALS}
              submitLabel={t("groups.add")}
              fields={[
                {
                  kind: "select",
                  name: "membershipId",
                  label: t("groups.member"),
                  required: true,
                  blankLabel: t("feed.pickOne"),
                  options: memberOptions(pickers.members),
                },
                {
                  kind: "checkboxes",
                  name: "owner",
                  label: t("groups.ownerLabel"),
                  options: [{ value: "on", label: t("groups.makeOwner") }],
                },
              ]}
            />
          ) : null}
        </KitSection>
        <CollabPanels ctx={ctx} table="app.groups" id={selected.id} />
      </PeekDrawer>
    );
  }

  const rows: KitRow[] = groups.data.map((g) => ({
    id: g.id,
    key: t(`groups.kinds.${g.kind}`),
    title: g.name,
    state: groupState(g, t),
    meta: t("groups.memberLine", { count: g.memberCount }),
    cells: {
      kind: t(`groups.kinds.${g.kind}`),
      name: g.name,
      state: groupState(g, t),
      members: g.memberCount,
    },
  }));
  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "kind", label: t("groups.kind") },
        { key: "name", label: t("groups.name"), wrap: true },
        { key: "state", label: t("feed.state"), type: "state" },
        { key: "members", label: t("groups.members"), type: "number" },
      ]}
      rows={rows}
      actions={
        canManage ? (
          <KitLink href={createHref} variant="primary">
            {t("groups.create")}
          </KitLink>
        ) : null
      }
      empty={
        canManage ? (
          <EmptyStateLink
            icon="Users"
            sentence={t("groups.empty")}
            actionLabel={t("groups.create")}
            href={createHref}
          />
        ) : (
          <EmptyRefresh icon="Users" sentence={t("groups.emptyRead")} />
        )
      }
    >
      {drawer}
    </CollectionView>
  );
}
