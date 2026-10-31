import { listDocumentTypes } from "@xos/data/document-types";
import { lastChange, listDocuments, type KnowledgeDocument } from "@xos/data/knowledge";
import { listSetupProgress, summarizeSetup } from "@xos/data/projects";
import { listProjectOptions } from "@xos/data/procurement";
import { getFormatter } from "next-intl/server";
import {
  addVersionAction,
  createDocumentAction,
  deleteDocumentAction,
  renameDocumentAction,
  setDocumentTypeAction,
} from "@/app/[org]/knowledge/actions";
import { CoEditLauncher } from "@/components/coedit/coedit-launcher";
import { CollabPanels } from "@/components/collection-kit/collab";
import { CollectionView } from "@/components/collection-kit/collection-view";
import { PresenceFor } from "@/components/presence/presence-for";
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
import type { KitRow, ViewKind } from "@/components/collection-kit/types";
import { PageHeader } from "@/components/collection-kit/ui";
import { DataTable } from "@/components/platform/client/data-table";
import { getCopy, type Copy } from "@/lib/collection-kit/i18n";
import { collectionState, withQuery, type SearchParams } from "@/lib/collection-kit/page";
import type { OrgContext } from "@/lib/shell/context";
import { rememberView } from "@/lib/shell/recents";
import { orgToday } from "@/lib/shell/time-zone";
import { getTranslate } from "@/lib/shell/translate";
import { CollectionPage } from "@/components/platform/collection-page";

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
  const [t, format, all, projects, types, setup] = await Promise.all([
    getCopy("knowledge"),
    getFormatter(),
    listDocuments(db, ctx.org.id),
    listProjectOptions(db, ctx.org.id),
    listDocumentTypes(db, ctx.org.id),
    projectId ? listSetupProgress(db, projectId) : Promise.resolve(null),
  ]);
  const title = projectId ? t("documents.projectTitle") : t("documents.title");
  if (!all.ok || !projects.ok) {
    return (
      <CollectionPage header={<PageHeader title={title} />}>
        <ErrorPanel what={t("documents.what")} />
      </CollectionPage>
    );
  }
  // B14 (3031): documents filed under the org's document types, filtered by ?docType=<id> (none for untyped).
  const documentTypes = types.ok ? types.data : [];
  const typeFilter = typeof search["docType"] === "string" ? search["docType"] : null;
  const docs = (projectId ? all.data.filter((d) => d.projectId === projectId) : all.data).filter(
    (d) =>
      typeFilter === null ||
      (typeFilter === "none" ? !d.documentTypeId : d.documentTypeId === typeFilter),
  );
  const typeName = (d: KnowledgeDocument) => d.documentTypeName ?? t("documentTypes.untyped");
  const presetType = typeof search["createType"] === "string" ? search["createType"] : "";
  const required = setup?.ok ? setup.data.filter((i) => i.kind === "Document") : [];
  const allTypesHref = (() => {
    const q = new URLSearchParams(state.baseQuery);
    q.delete("docType");
    q.delete("createType");
    return q.size > 0 ? `${path}?${q.toString()}` : path;
  })();
  const canWrite = canWriteProject ?? ctx.capabilities.has("knowledge.document.write");
  const when = (d: string) =>
    format.dateTime(new Date(d), { dateStyle: "medium", timeStyle: "short" });
  const selected = state.peek ? docs.find((d) => d.id === state.peek) : undefined;
  // The command menu's recent items (Section 11.7).
  if (selected) await rememberView(ctx, "documents", selected.id);
  const scopeOf = (d: KnowledgeDocument) => d.projectKey ?? t("documents.orgWide");
  const properties = (d: KnowledgeDocument) => [
    { label: t("documents.scope"), value: scopeOf(d) },
    { label: t("documentTypes.type"), value: typeName(d) },
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
        <PresenceFor table="documents" id={selected.id} />
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
            {documentTypes.length > 0 ? (
              <EntityForm
                id={`document-type-${selected.id}`}
                action={setDocumentTypeAction}
                hidden={{ org: ctx.org.slug, id: selected.id }}
                refusals={REFUSALS}
                submitLabel={t("documentTypes.save")}
                fields={[
                  {
                    kind: "select",
                    name: "documentTypeId",
                    label: t("documentTypes.type"),
                    blankLabel: t("documentTypes.untyped"),
                    defaultValue: selected.documentTypeId ?? "",
                    options: documentTypes.map((x) => ({ value: x.id, label: x.name })),
                  },
                ]}
              />
            ) : null}
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
    title: d.title,
    meta: t("documents.updatedLine", { date: when(lastChange(d)) }),
    cells: {
      title: d.title,
      scope: scopeOf(d),
      type: typeName(d),
      versions: d.versions.length,
      updated: when(lastChange(d)),
    },
  }));

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
            ...(documentTypes.length > 0
              ? [
                  {
                    kind: "select" as const,
                    name: "documentTypeId",
                    label: t("documentTypes.type"),
                    blankLabel: t("documentTypes.untyped"),
                    defaultValue: documentTypes.some((x) => x.id === presetType) ? presetType : "",
                    options: documentTypes.map((x) => ({ value: x.id, label: x.name })),
                  },
                ]
              : []),
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
        <PresenceFor table="documents" id={selected.id} />
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
        ...(documentTypes.length > 0 ? [{ key: "type", label: t("documentTypes.type") }] : []),
        { key: "versions", label: t("documents.versions"), type: "number" as const },
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
      filters={
        documentTypes.length > 0 || required.length > 0 ? (
          <div className="flex flex-col gap-8">
            {required.length > 0 ? (
              <section aria-labelledby="required-documents" className="flex flex-col gap-6">
                <h2 id="required-documents" className="m-0 text-text-13 font-semibold">
                  {t("documentTypes.requiredTitle")}
                </h2>
                <p className="m-0 text-text-12 text-text-secondary">
                  {t("documentTypes.requiredSummary", {
                    requiredMet: summarizeSetup(required).required.met,
                    requiredTotal: summarizeSetup(required).required.total,
                    recommendedMet: summarizeSetup(required).recommended.met,
                    recommendedTotal: summarizeSetup(required).recommended.total,
                  })}
                </p>
                <ul className="m-0 flex list-none flex-wrap gap-6 p-0">
                  {required.map((r) => (
                    <li key={r.requirementId} className="flex items-center gap-6 text-text-12">
                      <span>
                        {t("documentTypes.requiredLine", {
                          label: r.label,
                          state: r.satisfied ? t("documentTypes.met") : t("documentTypes.missing"),
                          requirement:
                            r.requirement === "Required"
                              ? t("documentTypes.required")
                              : t("documentTypes.recommended"),
                          gate: r.requiredByGate,
                        })}
                      </span>
                      {!r.satisfied && canWrite && r.documentTypeId ? (
                        <KitLink
                          size="sm"
                          href={withQuery(path, state, {
                            create: "1",
                            createType: r.documentTypeId,
                          })}
                        >
                          {t("documentTypes.addMissing", { type: r.label })}
                        </KitLink>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {documentTypes.length > 0 ? (
              <nav
                aria-label={t("documentTypes.filter")}
                className="flex flex-wrap items-center gap-6 text-text-12"
              >
                <span className="text-text-secondary">{t("documentTypes.filter")}:</span>
                <KitLink
                  size="sm"
                  variant={typeFilter === null ? "primary" : "ghost"}
                  href={allTypesHref}
                >
                  {t("documentTypes.allTypes")}
                </KitLink>
                {documentTypes.map((x) => (
                  <KitLink
                    key={x.id}
                    size="sm"
                    variant={typeFilter === x.id ? "primary" : "ghost"}
                    href={withQuery(path, state, { docType: x.id })}
                  >
                    {x.name}
                  </KitLink>
                ))}
                <KitLink
                  size="sm"
                  variant={typeFilter === "none" ? "primary" : "ghost"}
                  href={withQuery(path, state, { docType: "none" })}
                >
                  {t("documentTypes.untyped")}
                </KitLink>
              </nav>
            ) : null}
          </div>
        ) : undefined
      }
    >
      {drawer}
    </CollectionView>
  );
}
