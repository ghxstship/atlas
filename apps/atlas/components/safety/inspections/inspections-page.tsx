import { listProjectOptions } from "@xos/data/places";
import {
  inspectionProgress,
  listInspectionResultValues,
  listInspections,
  listInspectionTemplates,
  listPeopleNames,
  listPunchItemsForResults,
  type CanonEnumValue,
  type Inspection,
  type InspectionProgress,
  type InspectionTemplate,
} from "@xos/data/safety-permits";
import type { RecordState } from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import { getFormatter } from "next-intl/server";
import { setSafetyArchivedAction, signOffAction } from "@/app/[org]/safety/actions";
import { heldCapabilities } from "@/components/places/kit/access";
import { ActionButton, ConfirmButton } from "@/components/places/kit/buttons";
import { PeekBoard, PeekCalendar, PeekTable, QueryDrawer } from "@/components/places/kit/client";
import { Collaboration } from "@/components/places/kit/collaboration";
import {
  ArchiveFilter as ArchiveFilterLinks,
  BackLink,
  Collection,
  CollectionEmpty,
  CreateLink,
  EntityList,
  LinkFilter,
  RecordSection,
  SearchBox,
  type Search,
} from "@/components/places/kit/parts";
import {
  InlineAlert,
  PropertyList,
  StateChip,
  Tag,
  TemplateRecord,
} from "@/components/places/kit/ui";
import { chooseView, matchesSearch, param, withQuery } from "@/components/places/kit/views";
import { requireNode } from "@/lib/shell/require-node";
import type { OrgContext } from "@/lib/shell/context";
import { nodeHref } from "@/lib/shell/sitemap";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import { ResultForm, StartInspectionForm } from "./inspection-forms";

const NODE = "safety.inspections";

/** Board columns for the derived progress of an inspection, drawn with the record state tokens. */
const PROGRESS_STATE: Record<InspectionProgress, RecordState> = {
  "not-started": "proposed",
  "in-progress": "active",
  "ready-for-sign-off": "in-review",
  "signed-off": "complete",
};

/** Safety > Inspections at org level (Section 4.5.5), with a project filter. */
export async function InspectionsPage({
  params,
  search,
}: {
  params: Readonly<Record<string, string>>;
  search: Search;
}) {
  const ctx = await requireNode(NODE, params);
  return (
    <InspectionsView
      ctx={ctx}
      path={nodeHref(NODE, params) ?? "/"}
      search={search}
      projectId={param(search, "project")}
      showProjectFilter
      templatesHref={nodeHref("safety.inspection-templates", params) ?? "/"}
    />
  );
}

/**
 * Inspections run from org templates: list, table, board by progress and calendar. The runner records
 * canon results per item (a failure opens its punch item) and sign-off freezes the results; the
 * inspector can never sign off their own inspection.
 */
export async function InspectionsView({
  ctx,
  path,
  search,
  projectId,
  showProjectFilter,
  templatesHref,
}: {
  ctx: OrgContext;
  path: string;
  search: Search;
  projectId: string | undefined;
  showProjectFilter: boolean;
  templatesHref: string;
}) {
  const db = ctx.viewer.db;
  const archiveParam = param(search, "archive");
  const archive = archiveParam === "archived" || archiveParam === "all" ? archiveParam : "live";
  const [inspections, templates, projects, values, t, held, format] = await Promise.all([
    listInspections(db, { orgId: ctx.org.id, archive: "all", ...(projectId ? { projectId } : {}) }),
    listInspectionTemplates(db, ctx.org.id, "all"),
    listProjectOptions(db, ctx.org.id),
    listInspectionResultValues(db),
    getTranslate(),
    heldCapabilities(ctx),
    getFormatter(),
  ]);
  for (const r of [inspections, templates, projects, values]) {
    if (!r.ok) throw new Error(`Cannot load inspections: ${JSON.stringify(r.error)}`);
  }
  if (!inspections.ok || !templates.ok || !projects.ok || !values.ok) return null;
  const people = await listPeopleNames(
    db,
    inspections.data.flatMap((i) =>
      [i.inspectorId, i.signedOffBy].filter((x): x is string => x !== null),
    ),
  );
  if (!people.ok) throw new Error(`Cannot read names: ${JSON.stringify(people.error)}`);
  const canWrite = held.has("safety.inspection.write");
  const canSignOff = held.has("safety.inspection.sign_off");
  const templateBy = new Map(templates.data.map((tpl) => [tpl.id, tpl]));
  const projectBy = new Map(projects.data.map((p) => [p.id, p]));
  const projectLabel = (id: string) => {
    const p = projectBy.get(id);
    return p ? `${p.key} ${p.name}` : "";
  };
  const progressOf = (i: Inspection) =>
    inspectionProgress(i, templateBy.get(i.templateId)?.items.length ?? 0);
  const titleOf = (i: Inspection) =>
    templateBy.get(i.templateId)?.name ?? t("permits.inspections.untitled");
  const when = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });
  const q = param(search, "q");
  const inArchive = (archivedAt: string | null) =>
    archive === "all" || (archive === "archived") === (archivedAt !== null);
  const rows = inspections.data.filter(
    (i) => inArchive(i.archivedAt) && matchesSearch(q, titleOf(i), projectLabel(i.projectId)),
  );
  const peekId = param(search, "peek");
  const selected = peekId ? inspections.data.find((i) => i.id === peekId) : undefined;
  const liveTemplates = templates.data.filter(
    (tpl) => tpl.archivedAt === null && tpl.items.length > 0,
  );
  const projectOptions = projects.data.map((p) => ({ id: p.id, label: `${p.key} ${p.name}` }));
  const shared = {
    ctx,
    t,
    values: values.data,
    names: people.data,
    canWrite,
    canSignOff,
    projectLabel,
    when,
  };

  if (peekId && param(search, "full") === "1") {
    const template = selected ? templateBy.get(selected.templateId) : undefined;
    return (
      <div className="flex flex-col gap-12">
        <BackLink
          href={withQuery(path, search, { peek: undefined, full: undefined })}
          label={t("permits.inspections.back")}
        />
        {selected && template ? (
          <TemplateRecord
            propertiesLabel={t("places.kit.properties")}
            header={
              <header className="flex flex-wrap items-center gap-8 border-b border-border-subtle pb-12">
                <h1 className="m-0 text-heading-24 font-semibold">{template.name}</h1>
                <StateChip
                  state={PROGRESS_STATE[progressOf(selected)]}
                  label={t(`permits.progress.${progressOf(selected)}`)}
                />
              </header>
            }
            properties={<InspectionProperties inspection={selected} {...shared} />}
          >
            <Runner inspection={selected} template={template} {...shared} />
          </TemplateRecord>
        ) : (
          <InlineAlert tone="warning" title={t("places.kit.peekMissingTitle")}>
            {t("places.kit.peekMissing")}
          </InlineAlert>
        )}
      </div>
    );
  }

  const views = chooseView(NODE, param(search, "view"), {
    board: rows.length > 0,
    calendar: rows.length > 0,
    map: false,
  });
  let overlay = null;
  if (
    param(search, "create") === "1" &&
    canWrite &&
    liveTemplates.length > 0 &&
    projectOptions.length > 0
  ) {
    overlay = (
      <QueryDrawer title={t("permits.inspections.start")} closeKeys={["create"]}>
        <StartInspectionForm
          org={ctx.org.slug}
          projects={projectOptions}
          templates={liveTemplates.map((tpl) => ({ id: tpl.id, name: tpl.name }))}
          {...(projectId ? { defaultProjectId: projectId } : {})}
        />
      </QueryDrawer>
    );
  } else if (peekId) {
    const template = selected ? templateBy.get(selected.templateId) : undefined;
    overlay = (
      <QueryDrawer title={t("permits.inspections.peekTitle")} closeKeys={["peek"]}>
        {selected && template ? (
          <div className="flex flex-col gap-16">
            <div className="flex flex-wrap items-center justify-between gap-8">
              <h3 className="m-0 text-heading-20 font-semibold">{template.name}</h3>
              <Link
                href={withQuery(path, search, { full: "1" }) as Route}
                className="text-text-13 text-accent-text underline"
              >
                {t("permits.inspections.openRunner")}
              </Link>
            </div>
            <InspectionProperties inspection={selected} {...shared} />
            <Runner inspection={selected} template={template} {...shared} />
          </div>
        ) : (
          <InlineAlert tone="warning" title={t("places.kit.peekMissingTitle")}>
            {t("places.kit.peekMissing")}
          </InlineAlert>
        )}
      </QueryDrawer>
    );
  }

  let body;
  if (projectOptions.length === 0) {
    body = <InlineAlert tone="info">{t("permits.inspections.noProjects")}</InlineAlert>;
  } else if (liveTemplates.length === 0 && inspections.data.length === 0) {
    body = (
      <CollectionEmpty
        icon="ListChecks"
        sentence={t("permits.inspections.noTemplates")}
        actionLabel={t("permits.templates.create")}
        href={`${templatesHref}?create=1`}
      />
    );
  } else if (inspections.data.length === 0) {
    body = canWrite ? (
      <CollectionEmpty
        icon="ClipboardCheck"
        sentence={t("permits.inspections.empty")}
        actionLabel={t("permits.inspections.start")}
        href={withQuery(path, search, { create: "1" })}
      />
    ) : (
      <InlineAlert tone="info">{t("permits.inspections.emptyReadOnly")}</InlineAlert>
    );
  } else if (rows.length === 0) {
    body = <InlineAlert tone="info">{t("places.kit.noMatches")}</InlineAlert>;
  } else if (views.current === "table") {
    body = (
      <PeekTable
        label={t("permits.inspections.title")}
        pinStart={["template"]}
        columns={[
          { key: "template", label: t("permits.inspections.fields.template") },
          { key: "project", label: t("permits.inspections.fields.project") },
          { key: "when", label: t("permits.inspections.fields.when") },
          { key: "inspector", label: t("permits.inspections.fields.inspector") },
          { key: "progress", label: t("permits.inspections.fields.progress"), type: "state" },
          { key: "failures", label: t("permits.inspections.fields.failures"), type: "number" },
        ]}
        rows={rows.map((i) => ({
          id: i.id,
          template: titleOf(i),
          project: projectLabel(i.projectId),
          when: when(i.inspectedAt),
          inspector: i.inspectorId ? (people.data.get(i.inspectorId) ?? null) : null,
          progress: {
            state: PROGRESS_STATE[progressOf(i)],
            label: t(`permits.progress.${progressOf(i)}`),
          },
          failures: failures(i, values.data),
        }))}
      />
    );
  } else if (views.current === "board") {
    body = (
      <PeekBoard
        readOnly
        columns={(Object.keys(PROGRESS_STATE) as InspectionProgress[]).map((p) => ({
          state: PROGRESS_STATE[p],
          label: t(`permits.progress.${p}`),
          cards: rows
            .filter((i) => progressOf(i) === p)
            .map((i) => ({
              key: i.id,
              title: titleOf(i),
              meta: `${projectLabel(i.projectId)} · ${when(i.inspectedAt)}`,
              kind: "Inspection" as const,
            })),
        }))}
      />
    );
  } else if (views.current === "calendar") {
    const month = param(search, "month") ?? `${new Date().toISOString().slice(0, 7)}-01`;
    body = (
      <PeekCalendar
        month={month}
        today={new Date().toISOString().slice(0, 10)}
        events={rows.map((i) => ({
          id: i.id,
          date: i.inspectedAt.slice(0, 10),
          label: `${titleOf(i)} ${projectBy.get(i.projectId)?.key ?? ""}`.trim(),
          state: PROGRESS_STATE[progressOf(i)],
        }))}
      />
    );
  } else {
    body = (
      <EntityList
        label={t("permits.inspections.title")}
        path={path}
        search={search}
        rows={rows.map((i) => ({
          id: i.id,
          title: titleOf(i),
          meta: [
            projectLabel(i.projectId),
            when(i.inspectedAt),
            i.inspectorId ? people.data.get(i.inspectorId) : null,
          ]
            .filter(Boolean)
            .join(" · "),
          chips: (
            <>
              <StateChip
                state={PROGRESS_STATE[progressOf(i)]}
                label={t(`permits.progress.${progressOf(i)}`)}
                compact
              />
              {failures(i, values.data) > 0 ? (
                <Tag tone="danger">
                  {t("permits.inspections.failureCount", { count: failures(i, values.data) })}
                </Tag>
              ) : null}
              {i.archivedAt ? <Tag tone="warning">{t("places.kit.archived")}</Tag> : null}
            </>
          ),
        }))}
      />
    );
  }

  return (
    <Collection
      title={t("permits.inspections.title")}
      count={rows.length}
      views={views}
      primary={
        canWrite && liveTemplates.length > 0 && projectOptions.length > 0 ? (
          <CreateLink path={path} search={search} label={t("permits.inspections.start")} />
        ) : null
      }
      filters={
        <>
          <SearchBox path={path} search={search} label={t("permits.inspections.search")} />
          {showProjectFilter ? (
            <LinkFilter
              path={path}
              search={search}
              label={t("permits.inspections.fields.project")}
              queryKey="project"
              allLabel={t("permits.permits.allProjects")}
              options={projectOptions.map((p) => ({ value: p.id, label: p.label }))}
            />
          ) : null}
          <ArchiveFilterLinks path={path} search={search} current={archive} t={t} />
        </>
      }
      overlay={overlay}
    >
      {body}
    </Collection>
  );
}

function failures(inspection: Inspection, values: readonly CanonEnumValue[]): number {
  const failed = values.find((v) => v.code === "INSP_FAILED")?.id;
  return inspection.results.filter((r) => r.resultEnumId === failed).length;
}

interface Shared {
  ctx: OrgContext;
  t: Translate;
  values: readonly CanonEnumValue[];
  names: ReadonlyMap<string, string>;
  canWrite: boolean;
  canSignOff: boolean;
  projectLabel: (id: string) => string;
  when: (iso: string) => string;
}

function InspectionProperties({
  inspection,
  t,
  names,
  projectLabel,
  when,
  canWrite,
  ctx,
}: Shared & { inspection: Inspection }) {
  const none = t("places.kit.notRecorded");
  return (
    <div className="flex flex-col gap-12">
      <PropertyList
        items={[
          {
            label: t("permits.inspections.fields.project"),
            value: projectLabel(inspection.projectId),
          },
          { label: t("permits.inspections.fields.when"), value: when(inspection.inspectedAt) },
          {
            label: t("permits.inspections.fields.inspector"),
            value: inspection.inspectorId ? (names.get(inspection.inspectorId) ?? none) : none,
          },
          {
            label: t("permits.inspections.fields.signedOff"),
            value: inspection.signedOffAt
              ? t("permits.inspections.signedOffBy", {
                  name: inspection.signedOffBy ? (names.get(inspection.signedOffBy) ?? none) : none,
                  when: when(inspection.signedOffAt),
                })
              : t("permits.inspections.notSignedOff"),
          },
        ]}
      />
      {canWrite && !inspection.signedOffAt ? (
        <ActionButton
          action={setSafetyArchivedAction}
          org={ctx.org.slug}
          fields={{
            table: "inspections",
            id: inspection.id,
            archived: inspection.archivedAt ? "false" : "true",
          }}
          label={inspection.archivedAt ? t("places.kit.restore") : t("places.kit.archive.action")}
          variant={inspection.archivedAt ? "secondary" : "ghost"}
        />
      ) : null}
    </div>
  );
}

async function Runner({
  inspection,
  template,
  ctx,
  t,
  values,
  canWrite,
  canSignOff,
}: Shared & { inspection: Inspection; template: InspectionTemplate }) {
  const db = ctx.viewer.db;
  const punch = await listPunchItemsForResults(
    db,
    inspection.results.map((r) => r.id),
  );
  if (!punch.ok) throw new Error(`Cannot read punch items: ${JSON.stringify(punch.error)}`);
  const resultBy = new Map(inspection.results.map((r) => [r.itemId, r]));
  const valueBy = new Map(values.map((v) => [v.id, v]));
  const signedOff = inspection.signedOffAt !== null;
  const editable = canWrite && !signedOff && !inspection.archivedAt;
  const progress = inspectionProgress(inspection, template.items.length);
  return (
    <div className="flex flex-col gap-16">
      {signedOff ? (
        <InlineAlert tone="success">{t("permits.inspections.frozen")}</InlineAlert>
      ) : null}
      <RecordSection
        id="runner"
        title={t("permits.inspections.items", {
          done: inspection.results.length,
          total: template.items.length,
        })}
      >
        <ol className="m-0 flex list-none flex-col gap-16 p-0">
          {template.items.map((item, i) => {
            const result = resultBy.get(item.id);
            const value = result ? valueBy.get(result.resultEnumId) : undefined;
            const opened = result ? punch.data.get(result.id) : undefined;
            return (
              <li key={item.id} className="flex flex-col gap-8 border-b border-border-subtle pb-12">
                <div className="flex flex-wrap items-center gap-8 text-text-14">
                  <span className="font-medium">
                    {t("permits.inspections.itemLine", { n: i + 1, prompt: item.prompt })}
                  </span>
                  {item.critical ? (
                    <Tag tone="danger">{t("permits.templates.critical")}</Tag>
                  ) : null}
                  {value ? (
                    <Tag
                      tone={
                        value.code === "INSP_FAILED"
                          ? "danger"
                          : value.code === "INSP_PASSED"
                            ? "success"
                            : "warning"
                      }
                    >
                      {t(`permits.results.${value.code}`)}
                    </Tag>
                  ) : (
                    <Tag>{t("permits.inspections.notAnswered")}</Tag>
                  )}
                </div>
                {opened ? (
                  <p className="m-0 text-text-13 text-text-secondary">
                    {t("permits.inspections.punchOpened", { key: opened.displayKey })}
                  </p>
                ) : null}
                {result?.note && !editable ? (
                  <p className="m-0 text-text-13">{result.note}</p>
                ) : null}
                {editable ? (
                  <ResultForm
                    org={ctx.org.slug}
                    inspectionId={inspection.id}
                    item={item}
                    n={i + 1}
                    values={values}
                    current={
                      result ? { resultEnumId: result.resultEnumId, note: result.note } : null
                    }
                  />
                ) : null}
              </li>
            );
          })}
        </ol>
      </RecordSection>
      {canSignOff && !signedOff ? (
        <RecordSection id="sign-off" title={t("permits.inspections.signOffTitle")}>
          {progress === "ready-for-sign-off" ? (
            <ConfirmButton
              action={signOffAction}
              org={ctx.org.slug}
              fields={{ id: inspection.id }}
              label={t("permits.inspections.signOff")}
              title={t("permits.inspections.signOffConfirmTitle", { name: template.name })}
              description={t("permits.inspections.signOffConfirmBody")}
              confirmLabel={t("permits.inspections.signOff")}
            />
          ) : (
            <p className="m-0 text-text-13 text-text-secondary">
              {t("permits.inspections.answerAllFirst", {
                left: template.items.length - inspection.results.length,
              })}
            </p>
          )}
        </RecordSection>
      ) : null}
      <Collaboration
        db={db}
        org={ctx.org.slug}
        subject={{ table: "app.inspections", id: inspection.id }}
        me={ctx.viewer.person?.id ?? null}
        canPost
      />
    </div>
  );
}
