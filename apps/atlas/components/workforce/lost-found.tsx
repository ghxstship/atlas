import { listLostItems, LOST_ITEM_CATEGORIES, type LostItem } from "@xos/data/workforce-site";
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
} from "@/components/collection-kit/kit";
import type { KitRow, KitState, ViewKind } from "@/components/collection-kit/types";
import { PageHeader } from "@/components/collection-kit/ui";
import { EmptyStateLink } from "@/components/ui";
import {
  claimItemAction,
  disposeItemAction,
  logItemAction,
  settleClaimAction,
} from "@/lib/workforce/actions";
import type { Copy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import { nodeHref } from "@/lib/shell/sitemap";
import type { OrgContext } from "@/lib/shell/context";
import { orgToday } from "@/lib/shell/time-zone";
import { ProjectPicker, REFUSALS, chosenProject, orgPickers, workforceCopy } from "./shared";
import { CollectionPage } from "@/components/platform/collection-page";

const VIEWS: readonly ViewKind[] = ["table", "list", "gallery"];
const STATES = {
  Logged: "active",
  Claimed: "in-review",
  Returned: "complete",
  Disposed: "canceled",
} as const;

function itemState(i: LostItem, t: Copy): KitState {
  return { state: STATES[i.state], label: t(`lostFound.states.${i.state}`) };
}

/**
 * Site Operations > Lost and Found (Section 4.9 lost and found log): items found on site with photos,
 * where they are held and their claims. Field staff log items and take claims; a supervisor returns
 * the item to a verified claimant, rejects a claim with a reason, or disposes of an unclaimed item.
 */
export async function LostFoundSection({
  ctx,
  path,
  search,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
}) {
  const state = collectionState(search, VIEWS, await orgToday(ctx));
  const [t, format, pickers] = await Promise.all([
    workforceCopy(),
    getFormatter(),
    orgPickers(ctx),
  ]);
  const title = t("lostFound.title");
  const project = chosenProject(pickers.projects, search);
  if (project === null) {
    return (
      <CollectionPage header={<PageHeader title={title} />}>
        <EmptyStateLink
          icon="FolderPlus"
          sentence={t("site.noProjects")}
          actionLabel={t("site.openProjects")}
          href={nodeHref("projects.all", { org: ctx.org.slug }) ?? "/"}
        />
      </CollectionPage>
    );
  }
  const items = await listLostItems(ctx.viewer.db, project.id);
  const picker = <ProjectPicker t={t} path={path} projects={pickers.projects} current={project} />;
  if (!items.ok) {
    return (
      <CollectionPage header={<PageHeader title={title} />}>
        {picker}
        <ErrorPanel what={t("lostFound.what")} />
      </CollectionPage>
    );
  }
  const canLog = ctx.role !== "viewer";
  const scoped = {
    ...state,
    baseQuery: new URLSearchParams({
      ...Object.fromEntries(new URLSearchParams(state.baseQuery)),
      project: project.id,
    }).toString(),
  };
  const when = (d: string) =>
    format.dateTime(new Date(d), { dateStyle: "medium", timeStyle: "short" });
  const selected = state.peek ? items.data.find((i) => i.id === state.peek) : undefined;
  const createHref = withQuery(path, scoped, { create: "1" });

  let drawer = null;
  if (state.create && canLog) {
    drawer = (
      <FormDrawer title={t("lostFound.create")} closeHref={withQuery(path, scoped)}>
        <EntityForm
          id="item-log"
          action={logItemAction}
          hidden={{ org: ctx.org.slug, projectId: project.id }}
          refusals={REFUSALS}
          submitLabel={t("lostFound.create")}
          successHref={withQuery(path, scoped, { peek: "{id}" })}
          fields={[
            {
              kind: "select",
              name: "category",
              label: t("lostFound.category"),
              required: true,
              defaultValue: "Other",
              options: LOST_ITEM_CATEGORIES.map((c) => ({
                value: c,
                label: t(`lostFound.categories.${c}`),
              })),
            },
            {
              kind: "textarea",
              name: "description",
              label: t("lostFound.description"),
              required: true,
              rows: 3,
              help: t("lostFound.descriptionHelp"),
            },
            {
              kind: "text",
              name: "foundLocation",
              label: t("lostFound.foundLocation"),
              required: true,
            },
            { kind: "text", name: "storageLocation", label: t("lostFound.storageLocation") },
          ]}
        />
        <p className="m-0 text-text-12 text-text-secondary">{t("lostFound.photoNote")}</p>
      </FormDrawer>
    );
  } else if (selected) {
    const open = selected.claims.find((c) => c.decidedAt === null);
    drawer = (
      <PeekDrawer
        recordKey={selected.number}
        title={t(`lostFound.categories.${selected.category}`)}
        state={itemState(selected, t)}
        closeHref={withQuery(path, scoped)}
        fullHref={withQuery(path, scoped, { peek: selected.id })}
        properties={[
          { label: t("lostFound.foundAt"), value: when(selected.foundAt) },
          { label: t("lostFound.foundLocation"), value: selected.foundLocation },
          {
            label: t("lostFound.storageLocation"),
            value: selected.storageLocation ?? t("lostFound.noStorage"),
          },
          { label: t("lostFound.loggedBy"), value: selected.loggedBy ?? t("someone") },
        ]}
        actions={
          <>
            {open ? (
              <>
                <ActionButton
                  action={settleClaimAction}
                  hidden={{ org: ctx.org.slug, id: open.id, returned: "true" }}
                  label={t("lostFound.return")}
                  variant="primary"
                  confirm={{
                    title: t("lostFound.returnTitle", { name: open.claimantName }),
                    body: t("lostFound.returnBody"),
                  }}
                  refusals={REFUSALS}
                />
                <ActionButton
                  action={settleClaimAction}
                  hidden={{ org: ctx.org.slug, id: open.id, returned: "false" }}
                  label={t("lostFound.reject")}
                  variant="danger"
                  reason={t("lostFound.rejectReason")}
                  refusals={REFUSALS}
                />
              </>
            ) : null}
            {selected.state === "Logged" ? (
              <ActionButton
                action={disposeItemAction}
                hidden={{ org: ctx.org.slug, id: selected.id }}
                label={t("lostFound.dispose")}
                variant="danger"
                reason={t("lostFound.disposeReason")}
                refusals={REFUSALS}
              />
            ) : null}
          </>
        }
      >
        <p className="m-0 text-text-14">{selected.description}</p>
        {selected.state === "Logged" && canLog ? (
          <KitSection id="item-claim" title={t("lostFound.claim")}>
            <EntityForm
              id={`item-claim-${selected.id}`}
              action={claimItemAction}
              hidden={{ org: ctx.org.slug, id: selected.id }}
              refusals={REFUSALS}
              submitLabel={t("lostFound.recordClaim")}
              fields={[
                {
                  kind: "text",
                  name: "claimantName",
                  label: t("lostFound.claimantName"),
                  required: true,
                },
                {
                  kind: "text",
                  name: "claimantContact",
                  label: t("lostFound.claimantContact"),
                  required: true,
                  help: t("lostFound.contactHelp"),
                },
                {
                  kind: "textarea",
                  name: "proof",
                  label: t("lostFound.proof"),
                  required: true,
                  rows: 3,
                  help: t("lostFound.proofHelp"),
                },
              ]}
            />
          </KitSection>
        ) : null}
        <KitSection id="item-claims" title={t("lostFound.claims")}>
          {selected.claims.length === 0 ? (
            <p className="m-0 text-text-13 text-text-secondary">{t("lostFound.noClaims")}</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-8 p-0 text-text-13">
              {selected.claims.map((c) => (
                <li key={c.id}>
                  {t("lostFound.claimLine", {
                    name: c.claimantName,
                    contact: c.claimantContact,
                    date: when(c.createdAt),
                    outcome:
                      c.decidedAt === null
                        ? t("lostFound.pending")
                        : c.returned
                          ? t("lostFound.returned")
                          : t("lostFound.rejected", { note: c.note ?? "" }),
                  })}
                </li>
              ))}
            </ul>
          )}
        </KitSection>
        <CollabPanels ctx={ctx} table="app.lost_found_items" id={selected.id} />
      </PeekDrawer>
    );
  }

  const rows: KitRow[] = items.data.map((i) => ({
    id: i.id,
    key: i.number,
    title: i.description,
    state: itemState(i, t),
    meta: t("lostFound.line", {
      category: t(`lostFound.categories.${i.category}`),
      place: i.foundLocation,
    }),
    cells: {
      number: i.number,
      category: t(`lostFound.categories.${i.category}`),
      description: i.description,
      state: itemState(i, t),
      found: when(i.foundAt),
      storage: i.storageLocation,
    },
  }));
  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "number", label: t("lostFound.number"), type: "code" },
        { key: "category", label: t("lostFound.category") },
        { key: "description", label: t("lostFound.description"), wrap: true },
        { key: "state", label: t("feed.state"), type: "state" },
        { key: "found", label: t("lostFound.foundAt") },
        { key: "storage", label: t("lostFound.storageLocation") },
      ]}
      rows={rows}
      filters={picker}
      actions={
        canLog ? (
          <KitLink href={createHref} variant="primary">
            {t("lostFound.create")}
          </KitLink>
        ) : null
      }
      empty={
        canLog ? (
          <EmptyStateLink
            icon="PackageSearch"
            sentence={t("lostFound.empty")}
            actionLabel={t("lostFound.create")}
            href={createHref}
            secondary
          />
        ) : (
          <EmptyRefresh icon="PackageSearch" sentence={t("lostFound.emptyRead")} />
        )
      }
    >
      {drawer}
    </CollectionView>
  );
}
