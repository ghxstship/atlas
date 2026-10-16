import { listRecordKinds } from "@xos/data/canon";
import { listCurrencies, listProjects } from "@xos/data/finance";
import { listPhases } from "@xos/data/projects";
import { listTemplates, type Template, type TemplateVersion } from "@xos/data/workflow";
import type { Route } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { PageHeader, TemplateCollection } from "@/components/finance/ui";
import { InlineAlert } from "@/components/ui";
import type { OrgContext } from "@/lib/shell/context";
import { EmptyPanel, ErrorPanel } from "./kit";
import {
  AddItemForm,
  ApplyTemplateForm,
  CreateTemplateForm,
  DeleteTemplateButton,
  NewDraftButton,
  PublishButton,
  RemoveItemButton,
  SaveProjectForm,
  VersionDefaultsForm,
} from "./templates-client";

/**
 * Projects > Templates (Section 4.5.5, A33): the org's project templates. Pick a template to see
 * its versions; edit the draft's defaults and items, publish it, and create a project from the
 * current version. A project can also be saved as a new template. projects.template.write edits;
 * projects.project.create creates projects. Row level security decides what appears.
 */
export async function TemplatesView({
  ctx,
  selected,
}: {
  ctx: OrgContext;
  selected: string | null;
}) {
  const t = (await getTranslations("workflow")) as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;
  const org = ctx.org.slug;
  const title = t("templates.title");
  const db = ctx.viewer.db;
  const canEdit = ctx.capabilities.has("projects.template.write");
  const canCreateProject = ctx.capabilities.has("projects.project.create");
  const [templates, projects, kinds, phases, currencies] = await Promise.all([
    listTemplates(db, ctx.org.id),
    listProjects(db, ctx.org.id),
    listRecordKinds(db),
    listPhases(db),
    listCurrencies(db),
  ]);
  if (!templates.ok || !projects.ok || !kinds.ok || !phases.ok || !currencies.ok) {
    return (
      <TemplateCollection header={<PageHeader title={title} />}>
        <ErrorPanel sentence={t("templates.loadError")} />
      </TemplateCollection>
    );
  }
  const locale = await getLocale();
  const day = (iso: string) =>
    new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(iso));
  const zones = Intl.supportedValuesOf("timeZone");
  const currencyCodes = currencies.data.map((c) => c.code);
  const current = templates.data.find((x) => x.id === selected) ?? null;
  const recordKinds = kinds.data.map((k) => ({ value: k.kind, label: k.kind }));
  const phaseChoices = phases.data.map((p) => ({ value: p.code, label: `${p.code} ${p.name}` }));

  return (
    <TemplateCollection header={<PageHeader title={title} count={templates.data.length} />}>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-24 max-lg:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-24">
          <p className="m-0 max-w-layout-reading text-text-13 text-text-secondary">
            {t("templates.sentence")}
          </p>
          {templates.data.length === 0 ? (
            <EmptyPanel
              icon="LayoutTemplate"
              sentence={canEdit ? t("templates.empty.editor") : t("templates.empty.reader")}
              actionLabel={
                canEdit ? t("templates.empty.editorAction") : t("templates.empty.readerAction")
              }
              href={canEdit ? `/${org}/projects/templates#create-template` : `/${org}/projects/all`}
            />
          ) : (
            <ul
              className="m-0 flex list-none flex-col gap-8 p-0"
              aria-label={t("templates.listLabel")}
            >
              {templates.data.map((tpl) => {
                const published = tpl.versions.find((v) => v.id === tpl.currentVersionId);
                return (
                  <li key={tpl.id}>
                    <Link
                      href={`/${org}/projects/templates?template=${tpl.id}` as Route}
                      aria-current={tpl.id === current?.id ? "true" : undefined}
                      className={`flex flex-col gap-2 rounded-card border p-12 ${
                        tpl.id === current?.id
                          ? "border-accent bg-bg-selected"
                          : "border-border-subtle hover:bg-bg-hover"
                      }`}
                    >
                      <span className="text-text-14 font-semibold text-text-primary">
                        {tpl.name}
                      </span>
                      <span className="text-text-12 text-text-secondary">
                        {published
                          ? t("templates.summary", {
                              version: published.number,
                              items: published.items.length,
                              projects: tpl.applications,
                            })
                          : t("templates.summaryDraft")}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          {canEdit ? (
            <section
              id="create-template"
              aria-labelledby="create-template-title"
              className="flex flex-col gap-8"
            >
              <h2 id="create-template-title" className="m-0 text-heading-16 font-semibold">
                {t("templates.create.title")}
              </h2>
              <CreateTemplateForm org={org} zones={zones} currencies={currencyCodes} />
            </section>
          ) : null}
          {canEdit && projects.data.length > 0 ? (
            <section aria-labelledby="save-project-title" className="flex flex-col gap-8">
              <h2 id="save-project-title" className="m-0 text-heading-16 font-semibold">
                {t("templates.fromProject.title")}
              </h2>
              <p className="m-0 text-text-13 text-text-secondary">
                {t("templates.fromProject.sentence")}
              </p>
              <SaveProjectForm
                org={org}
                projects={projects.data.map((p) => ({ value: p.id, label: `${p.key} ${p.name}` }))}
              />
            </section>
          ) : null}
        </div>

        <div className="min-w-0">
          {current === null ? (
            <InlineAlert tone="info">
              {templates.data.length === 0
                ? t("templates.detail.none")
                : t("templates.detail.pick")}
            </InlineAlert>
          ) : (
            <TemplateDetail
              t={t}
              org={org}
              template={current}
              day={day}
              canEdit={canEdit}
              canCreateProject={canCreateProject}
              zones={zones}
              currencies={currencyCodes}
              recordKinds={recordKinds}
              phases={phaseChoices}
            />
          )}
        </div>
      </div>
    </TemplateCollection>
  );
}

function ItemList({
  t,
  org,
  version,
  removable,
}: {
  t: (key: string, values?: Record<string, string | number>) => string;
  org: string;
  version: TemplateVersion;
  removable: boolean;
}) {
  if (version.items.length === 0) {
    return <p className="m-0 text-text-13 text-text-secondary">{t("templates.items.none")}</p>;
  }
  return (
    <ol className="m-0 flex list-none flex-col gap-6 p-0" aria-label={t("templates.items.label")}>
      {version.items.map((i) => (
        <li
          key={i.id}
          className="flex flex-wrap items-center justify-between gap-8 rounded-control border border-border-subtle px-12 py-6"
        >
          <span className="flex min-w-0 flex-col">
            <span className="text-text-13 font-medium">{i.name}</span>
            <span className="text-text-12 text-text-secondary">
              {i.kind === "Scope Node"
                ? t("templates.items.nodeLine", {
                    kind: t(`templates.items.scopeKinds.${i.scopeKind ?? "Show"}`),
                    suffix: i.scopeCodeSuffix ?? "",
                  })
                : t("templates.items.recordLine", {
                    kind: i.recordKind ?? "",
                    phase: i.phaseCode ?? t("templates.items.noPhase"),
                    due:
                      i.dueOffsetDays === null
                        ? t("templates.items.noDue")
                        : t("templates.items.dueIn", { days: i.dueOffsetDays }),
                  })}
            </span>
          </span>
          {removable ? <RemoveItemButton org={org} id={i.id} name={i.name} /> : null}
        </li>
      ))}
    </ol>
  );
}

function TemplateDetail({
  t,
  org,
  template,
  day,
  canEdit,
  canCreateProject,
  zones,
  currencies,
  recordKinds,
  phases,
}: {
  t: (key: string, values?: Record<string, string | number>) => string;
  org: string;
  template: Template;
  day: (iso: string) => string;
  canEdit: boolean;
  canCreateProject: boolean;
  zones: readonly string[];
  currencies: readonly string[];
  recordKinds: readonly { value: string; label: string }[];
  phases: readonly { value: string; label: string }[];
}) {
  const published = template.versions.find((v) => v.id === template.currentVersionId) ?? null;
  const draft = template.versions.find((v) => v.publishedAt === null) ?? null;
  return (
    <article
      aria-labelledby="template-title"
      className="flex flex-col gap-24 rounded-card border border-border-subtle p-16"
    >
      <header className="flex flex-wrap items-start justify-between gap-8">
        <div className="flex flex-col gap-4">
          <h2 id="template-title" className="m-0 text-heading-20 font-semibold">
            {template.name}
          </h2>
          {template.description ? (
            <p className="m-0 text-text-13 text-text-secondary">{template.description}</p>
          ) : null}
          <p className="m-0 text-text-12 text-text-tertiary">
            {t("templates.detail.applications", { count: template.applications })}
          </p>
        </div>
        {canEdit ? <DeleteTemplateButton org={org} id={template.id} /> : null}
      </header>

      <section aria-labelledby="template-current" className="flex flex-col gap-8">
        <h3 id="template-current" className="m-0 text-text-15 font-semibold">
          {published
            ? t("templates.detail.current", {
                version: published.number,
                date: day(published.publishedAt ?? ""),
              })
            : t("templates.detail.noCurrent")}
        </h3>
        {published ? (
          <>
            <p className="m-0 text-text-12 text-text-secondary">
              {t("templates.detail.defaults", {
                zone: published.timeZone ?? t("templates.fields.notSet"),
                currency: published.currency ?? t("templates.fields.notSet"),
                days:
                  published.durationDays === null
                    ? t("templates.fields.notSet")
                    : String(published.durationDays),
              })}
            </p>
            <ItemList t={t} org={org} version={published} removable={false} />
            {canCreateProject ? (
              <section aria-labelledby="template-apply" className="flex flex-col gap-8">
                <h4 id="template-apply" className="m-0 text-text-14 font-semibold">
                  {t("templates.apply.title")}
                </h4>
                <ApplyTemplateForm
                  org={org}
                  templateId={template.id}
                  zones={zones}
                  needsZone={published.timeZone === null}
                />
              </section>
            ) : (
              <p className="m-0 text-text-12 text-text-secondary">
                {t("templates.apply.needsCapability")}
              </p>
            )}
          </>
        ) : null}
      </section>

      {canEdit ? (
        <section
          aria-labelledby="template-draft"
          className="flex flex-col gap-12 border-t border-border-subtle pt-16"
        >
          <h3 id="template-draft" className="m-0 text-text-15 font-semibold">
            {draft
              ? t("templates.draft.title", { version: draft.number })
              : t("templates.draft.noneTitle")}
          </h3>
          {draft ? (
            <>
              <p className="m-0 text-text-12 text-text-secondary">
                {t("templates.draft.sentence")}
              </p>
              <VersionDefaultsForm
                org={org}
                version={draft}
                zones={zones}
                currencies={currencies}
              />
              <ItemList t={t} org={org} version={draft} removable />
              <AddItemForm
                org={org}
                versionId={draft.id}
                recordKinds={recordKinds}
                phases={phases}
              />
              <PublishButton org={org} versionId={draft.id} />
            </>
          ) : (
            <>
              <p className="m-0 text-text-12 text-text-secondary">{t("templates.draft.none")}</p>
              <NewDraftButton org={org} templateId={template.id} />
            </>
          )}
        </section>
      ) : null}

      {template.versions.length > 0 ? (
        <section aria-labelledby="template-history" className="flex flex-col gap-6">
          <h3 id="template-history" className="m-0 text-text-15 font-semibold">
            {t("templates.history.title")}
          </h3>
          <ul className="m-0 flex list-none flex-col gap-2 p-0 text-text-12 text-text-secondary">
            {template.versions.map((v) => (
              <li key={v.id}>
                {v.publishedAt
                  ? t("templates.history.published", {
                      version: v.number,
                      date: day(v.publishedAt),
                      items: v.items.length,
                    })
                  : t("templates.history.draft", { version: v.number, items: v.items.length })}
                {v.notes ? ` ${v.notes}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}
