import { lastChange, listDocuments, type KnowledgeDocument } from "@xos/data/knowledge";
import { listProjectOptions } from "@xos/data/procurement";
import { getFormatter } from "next-intl/server";
import {
  addVersionAction,
  createDocumentAction,
  deleteDocumentAction,
  renameDocumentAction,
} from "@/app/[org]/knowledge/actions";
import { CoEditLauncher } from "@/components/coedit/coedit-launcher";
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
import type { BulkConfig } from "@/components/bulk/types";
import type { KitRow, ViewKind } from "@/components/collection-kit/types";
import { PageHeader } from "@/components/collection-kit/ui";
import { DataTable } from "@/components/platform/client/data-table";
import { getCopy, type Copy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { rememberView } from "@/lib/shell/recents";
import { orgToday } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";

const VIEWS: readonly ViewKind[] = ["list", "table", "gallery"];
const REFUSALS = "knowledge.refusals";

/**
 * Knowledge > Documents (and the project Documents tab): documents of the org or of a project with
 * append-only versions. Each version records where the file lives and its SHA-256 fingerprint,
 * computed in the browser from the chosen file, so a later copy can be checked against it.
 */
export async function DocumentsSection({
  ctx,
  path,
  search,
  projectId,
  canWriteProject,
}: {
  ctx: OrgContext;
  path: string;
  search: SearchParams;
  projectId?: string;
  /** On a project tab: whether the viewer writes documents on this project (assigned reach counts). */
  canWriteProject?: boolean;
}) {
  const state = collectionState(search, VIEWS, await orgToday(ctx));
  const db = ctx.viewer.db;
  const [t, format, all, projects] = await Promise.all([
    getCopy("knowledge"),
    getFormatter(),
    listDocuments(db, ctx.org.id),
    listProjectOptions(db, ctx.org.id),
  ]);
  const title = projectId ? t("documents.projectTitle") : t("documents.title");
  if (!all.ok || !projects.ok) {
    return (
      <>
        <PageHeader title={title} />
        <ErrorPanel what={t("documents.what")} />
      </>
    );
  }
  const docs = projectId ? all.data.filter((d) => d.projectId === projectId) : all.data;
  const canWrite = canWriteProject ?? ctx.capabilities.has("knowledge.document.write");
  const when = (d: string) =>
    format.dateTime(new Date(d), { dateStyle: "medium", timeStyle: "short" });
  const selected = state.peek ? docs.find((d) => d.id === state.peek) : undefined;
  // The command menu's recent items (Section 11.7).
  if (selected) await rememberView(ctx, "documents", selected.id);
  const scopeOf = (d: KnowledgeDocument) => d.projectKey ?? t("documents.orgWide");
  const properties = (d: KnowledgeDocument) => [
    { label: t("documents.scope"), value: scopeOf(d) },
    { label: t("documents.versions"), value: String(d.versions.length) },
    { label: t("documents.updated"), value: when(lastChange(d)) },
    {
      label: t("documents.latest"),
      value: d.latestVersion
        ? t("documents.versionLabel", { n: d.latestVersion.versionNumber })
        : t("documents.noVersions"),
    },
  ];
  const actions = (d: KnowledgeDocument) =>
    canWrite ? (
      <ActionButton
        action={deleteDocumentAction}
        hidden={{ org: ctx.org.slug, id: d.id }}
        label={t("documents.delete")}
        variant="danger"
        confirm={{
          title: t("documents.deleteTitle", { title: d.title }),
          body: t("documents.deleteBody"),
        }}
        refusals={REFUSALS}
      />
    ) : null;
  const versions = (d: KnowledgeDocument, tr: Copy) => (
    <KitSection id={`versions-${d.id}`} title={tr("documents.versionHistory")}>
      {d.versions.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{tr("documents.noVersions")}</p>
      ) : (
        <DataTable
          caption={tr("documents.versionHistory")}
          columns={[
            { key: "n", label: tr("documents.version"), type: "number" },
            { key: "uri", label: tr("documents.location"), wrap: true },
            { key: "sha", label: tr("documents.fingerprint"), type: "code" },
            { key: "by", label: tr("documents.addedBy") },
            { key: "at", label: tr("documents.addedAt") },
          ]}
          rows={d.versions.map((v) => ({
            n: v.versionNumber,
            uri: v.storageUri,
            sha: v.checksumSha256.slice(0, 12),
            by: v.createdByName ?? tr("documents.someone"),
            at: when(v.createdAt),
          }))}
        />
      )}
      {canWrite ? (
        <EntityForm
          id={`version-add-${d.id}`}
          action={addVersionAction}
          hidden={{ org: ctx.org.slug, documentId: d.id }}
          refusals={REFUSALS}
          submitLabel={tr("documents.addVersion")}
          fields={[
            {
              kind: "url",
              name: "storageUri",
              label: tr("documents.location"),
              required: true,
              help: tr("documents.locationHelp"),
            },
            {
              kind: "file-checksum",
              name: "checksum",
              label: tr("documents.file"),
              help: tr("documents.fileHelp"),
            },
          ]}
        />
      ) : null}
    </KitSection>
  );

  if (selected && state.full) {
    const tRoot = await getTranslate();
    const person = ctx.viewer.person;
    return (
      <RecordPage
        backHref={withQuery(path, state)}
        backLabel={t("documents.back")}
        recordKey={scopeOf(selected)}
        title={selected.title}
        properties={properties(selected)}
        actions={actions(selected)}
      >
        {canWrite ? (
          <KitSection id="document-rename" title={t("documents.details")}>
            <EntityForm
              id={`document-rename-${selected.id}`}
              action={renameDocumentAction}
              hidden={{ org: ctx.org.slug, id: selected.id }}
              refusals={REFUSALS}
              submitLabel={t("documents.save")}
              fields={[
                {
                  kind: "text",
                  name: "title",
                  label: t("documents.documentTitle"),
                  required: true,
                  defaultValue: selected.title,
                },
              ]}
            />
          </KitSection>
        ) : null}
        {versions(selected, t)}
        {person ? (
          // Live co-edited notes (Section 5): kept in the document's snapshots, edited on demand.
          <KitSection id={`notes-${selected.id}`} title={tRoot("collab.coedit.notes")}>
            <CoEditLauncher
              org={ctx.org.slug}
              subject="document"
              id={selected.id}
              label={tRoot("collab.coedit.notes")}
              me={{ key: person.id, name: person.fullName ?? tRoot("collab.history.someone") }}
              openLabel={tRoot("collab.coedit.openNotes")}
              loadingLabel={tRoot("collab.coedit.loading")}
            >
              <p className="m-0 text-text-13 text-text-secondary">
                {tRoot("collab.coedit.notesHelp")}
              </p>
            </CoEditLauncher>
          </KitSection>
        ) : null}
        <CollabPanels ctx={ctx} table="app.documents" id={selected.id} />
      </RecordPage>
    );
  }

  const rows: KitRow[] = docs.map((d) => ({
    id: d.id,
    key: scopeOf(d),
    label: d.title,
    title: d.title,
    meta: t("documents.updatedLine", { date: when(lastChange(d)) }),
    cells: {
      title: d.title,
      scope: scopeOf(d),
      versions: d.versions.length,
      updated: when(lastChange(d)),
    },
  }));

  // Bulk edit (Section 11.7): move documents to a project or org-wide. The database checks
  // knowledge.document.write where each document is and where it goes.
  const bulk: BulkConfig | null = canWrite
    ? {
        org: ctx.org.slug,
        resource: "documents",
        fields: [
          {
            key: "project_id",
            label: t("documents.scope"),
            options: [
              { value: null, label: t("documents.orgWide") },
              ...projects.data.map((p) => ({ value: p.id, label: `${p.key} ${p.name}` })),
            ],
          },
        ],
      }
    : null;

  let drawer = null;
  if (state.create && canWrite) {
    drawer = (
      <FormDrawer title={t("documents.create")} closeHref={withQuery(path, state)}>
        <EntityForm
          id="document-create"
          action={createDocumentAction}
          hidden={projectId ? { org: ctx.org.slug, projectId } : { org: ctx.org.slug }}
          refusals={REFUSALS}
          submitLabel={t("documents.create")}
          successHref={withQuery(path, state, { peek: "{id}" })}
          fields={[
            { kind: "text", name: "title", label: t("documents.documentTitle"), required: true },
            ...(projectId
              ? []
              : [
                  {
                    kind: "select" as const,
                    name: "projectId",
                    label: t("documents.scope"),
                    blankLabel: t("documents.orgWide"),
                    defaultValue: "",
                    options: projects.data.map((p) => ({
                      value: p.id,
                      label: `${p.key} ${p.name}`,
                    })),
                  },
                ]),
            {
              kind: "url",
              name: "storageUri",
              label: t("documents.location"),
              required: true,
              help: t("documents.locationHelp"),
            },
            {
              kind: "file-checksum",
              name: "checksum",
              label: t("documents.file"),
              help: t("documents.fileHelp"),
            },
          ]}
        />
      </FormDrawer>
    );
  } else if (selected) {
    drawer = (
      <PeekDrawer
        recordKey={scopeOf(selected)}
        title={selected.title}
        closeHref={withQuery(path, state)}
        fullHref={withQuery(path, state, { peek: selected.id, full: "1" })}
        properties={properties(selected)}
        actions={actions(selected)}
      >
        {versions(selected, t)}
      </PeekDrawer>
    );
  }

  return (
    <CollectionView
      title={title}
      views={VIEWS}
      view={state.view}
      columns={[
        { key: "title", label: t("documents.documentTitle"), wrap: true },
        { key: "scope", label: t("documents.scope") },
        { key: "versions", label: t("documents.versions"), type: "number" },
        { key: "updated", label: t("documents.updated") },
      ]}
      rows={rows}
      actions={
        canWrite ? (
          <KitLink href={withQuery(path, state, { create: "1" })} variant="primary">
            {t("documents.create")}
          </KitLink>
        ) : null
      }
      empty={emptyFor(t, canWrite, withQuery(path, state, { create: "1" }), "documents")}
      bulk={bulk}
    >
      {drawer}
    </CollectionView>
  );
}
