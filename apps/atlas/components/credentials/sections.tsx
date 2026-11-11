import {
  getCredentialCategory,
  listAccessGrid,
  listAccessLevels,
  listCategoryRequirements,
  listCredentialCategories,
  listProjectZones,
  type AccessGridEntry,
  type CategoryRequirement,
  type CredentialCategory,
  type Zone,
} from "@xos/data/credentials";
import { listCertifications } from "@xos/data/people";
import { listTrainingCourses } from "@xos/data/workforce-training";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import {
  chooseProjectNotice,
  dateTime,
  Header,
  ProjectFilter,
  RecordChrome,
  RecordMissing,
  sectionHref,
  unwrap,
} from "@/components/operations/chrome";
import { ActionForm } from "@/components/operations/action-form";
import { ReportedActionForm } from "@/components/operations/reported-action-form";
import { ResultRegion } from "@/components/operations/result-region";
import { SelectField, TextField } from "@/components/operations/fields";
import {
  joined,
  OpsList,
  OpsTable,
  param,
  Properties,
  RecordSection,
  type Column,
} from "@/components/operations/kit";
import { RecordCollab } from "@/components/operations/record-collab";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import {
  addRequirementAction,
  archiveCategoryAction,
  createCategoryAction,
  grantZoneAccessAction,
  removeRequirementAction,
  updateCategoryAction,
  updateZoneAccessAction,
  withdrawZoneAccessAction,
} from "@/lib/credentials/actions";
import { can, chooseView, type ModulePage } from "@/lib/operations/context";
import { instantToLocal } from "@/lib/operations/time";
import { AccessMatrixEditor } from "./client";
import { CollectionPage } from "@/components/platform/collection-page";

/**
 * The Credentials module (Section 4.2: categories, issuance, the access grid and scans), one
 * section per sitemap page. Each section renders the Collection template: header with the view
 * switcher and primary action, the filter bar, the view, and the side peek or full page of the
 * record named in the URL. The org pages and the project tab share these sections.
 */

// Categories -------------------------------------------------------------------------------------

export async function CategoriesSection({ page }: { page: ModulePage }) {
  const t = page.t;
  const section = "categories";
  const { views, view } = chooseView("credentials.categories", param(page.search, "view"));
  const categories = unwrap(
    await listCredentialCategories(page.ctx.viewer.db, {
      orgId: page.ctx.org.id,
      ...(page.project ? { projectId: page.project.id } : {}),
    }),
    "credential categories",
  );
  const peekId = param(page.search, "peek");
  const creating = param(page.search, "create") === "1";
  const canWrite = can(page, "credentials.category.write");
  const title = t("nav.atlas.pages.credentials.categories");
  const peekHref = (c: CredentialCategory) =>
    sectionHref(page, { peek: c.id, full: undefined, create: undefined, section });

  const columns: Column<CredentialCategory>[] = [
    {
      key: "code",
      label: t("credentials.categories.code"),
      primary: true,
      render: (c) => <span className="font-mono">{c.code}</span>,
    },
    { key: "name", label: t("credentials.categories.name"), primary: true, render: (c) => c.name },
    { key: "project", label: t("credentials.common.project"), render: (c) => c.projectKey },
    {
      key: "active",
      label: t("credentials.categories.active"),
      numeric: true,
      primary: true,
      render: (c) => c.activeCount,
    },
  ];

  return (
    <CollectionPage
      header={
        <Header
          page={page}
          section={section}
          title={title}
          count={categories.length}
          views={views}
          view={view}
          action={
            canWrite ? (
              <ButtonLink
                href={sectionHref(page, { create: "1", peek: undefined, section })}
                variant="primary"
              >
                {t("credentials.categories.new")}
              </ButtonLink>
            ) : undefined
          }
        />
      }
    >
      <ProjectFilter page={page} section={section} />
      {creating && canWrite ? (
        page.project ? (
          <RecordSection id="new-category" title={t("credentials.categories.new")}>
            <ActionForm
              action={createCategoryAction}
              hidden={{ org: page.ctx.org.slug, projectId: page.project.id }}
              submitLabel={t("credentials.categories.create")}
              successKey="credentials.categories.created"
              layout="inline"
              resetOnSuccess
            >
              <TextField
                id="category-code"
                name="code"
                label={t("credentials.categories.code")}
                help={t("credentials.categories.codeHelp")}
                required
                maxLength={16}
              />
              <TextField
                id="category-name"
                name="name"
                label={t("credentials.categories.name")}
                required
                maxLength={100}
              />
              <SelectField
                id="category-kind"
                name="kind"
                label={t("credentials.categories.categoryKind")}
                help={t("credentials.categories.categoryKindHelp")}
                options={[
                  { value: "Access", label: t("credentials.categories.categoryKinds.access") },
                  { value: "Parking", label: t("credentials.categories.categoryKinds.parking") },
                ]}
              />
            </ActionForm>
          </RecordSection>
        ) : (
          chooseProjectNotice(page, section)
        )
      ) : null}
      {categories.length === 0 ? (
        <EmptyStateLink
          icon="IdCard"
          sentence={t("credentials.categories.empty")}
          actionLabel={t("credentials.categories.new")}
          href={sectionHref(page, { create: "1", section })}
        />
      ) : view === "table" ? (
        <OpsTable
          caption={title}
          columns={columns}
          rows={categories}
          rowKey={(c) => c.id}
          rowHref={peekHref}
          selected={peekId}
        />
      ) : (
        <OpsList
          label={title}
          items={categories.map((c) => ({
            key: c.id,
            href: peekHref(c),
            title: `${c.code} · ${c.name}`,
            meta: t("credentials.categories.meta", { project: c.projectKey, count: c.activeCount }),
          }))}
        />
      )}
      {peekId ? (
        <CategoryRecord page={page} id={peekId} section={section} canWrite={canWrite} />
      ) : null}
    </CollectionPage>
  );
}

async function CategoryRecord({
  page,
  id,
  section,
  canWrite,
}: {
  page: ModulePage;
  id: string;
  section: string;
  canWrite: boolean;
}) {
  const t = page.t;
  const result = await getCredentialCategory(page.ctx.viewer.db, id);
  const closeHref = sectionHref(page, { peek: undefined, full: undefined, section });
  if (!result.ok) return <RecordMissing page={page} closeHref={closeHref} />;
  const c = result.data;
  const project = page.projects.find((p) => p.id === c.projectId);
  return (
    <RecordChrome
      page={page}
      full={param(page.search, "full") === "1"}
      title={c.name}
      recordKey={c.code}
      kindLabel={t("credentials.categories.kind")}
      closeHref={closeHref}
      fullHref={sectionHref(page, { peek: c.id, full: "1", section })}
      properties={
        <Properties
          label={t("credentials.common.properties")}
          rows={[
            {
              label: t("credentials.categories.code"),
              value: <span className="font-mono">{c.code}</span>,
            },
            {
              label: t("credentials.common.project"),
              value: project ? `${project.key} · ${project.name}` : c.projectKey,
            },
            { label: t("credentials.categories.active"), value: c.activeCount },
          ]}
        />
      }
    >
      <RecordSection
        id="category-issued"
        title={t("credentials.categories.issuedHeading")}
        actions={
          <ButtonLink
            href={
              `/${page.ctx.org.slug}/credentials/issued?project=${c.projectKey}&category=${c.id}` as Route
            }
            size="sm"
          >
            {t("credentials.categories.viewIssued")}
          </ButtonLink>
        }
      >
        <p className="m-0 text-text-13 text-text-secondary">
          {t("credentials.categories.issuedSummary", { count: c.activeCount })}
        </p>
      </RecordSection>
      <RequirementsSection page={page} categoryId={c.id} canWrite={canWrite} />
      {canWrite ? (
        <>
          <RecordSection id="category-edit" title={t("credentials.common.edit")}>
            <ActionForm
              action={updateCategoryAction}
              hidden={{ org: page.ctx.org.slug, id: c.id }}
              submitLabel={t("credentials.common.save")}
              successKey="credentials.common.saved"
            >
              <TextField
                id="edit-category-code"
                name="code"
                label={t("credentials.categories.code")}
                defaultValue={c.code}
                required
                maxLength={16}
              />
              <TextField
                id="edit-category-name"
                name="name"
                label={t("credentials.categories.name")}
                defaultValue={c.name}
                required
                maxLength={100}
              />
              <SelectField
                id="edit-category-kind"
                name="kind"
                label={t("credentials.categories.categoryKind")}
                help={t("credentials.categories.categoryKindHelp")}
                defaultValue={c.kind}
                options={[
                  { value: "Access", label: t("credentials.categories.categoryKinds.access") },
                  { value: "Parking", label: t("credentials.categories.categoryKinds.parking") },
                ]}
              />
            </ActionForm>
          </RecordSection>
          <RecordSection id="category-archive" title={t("credentials.categories.archiveHeading")}>
            <p className="m-0 text-text-13 text-text-secondary">
              {t("credentials.categories.archiveHelp")}
            </p>
            <ActionForm
              action={archiveCategoryAction}
              hidden={{ org: page.ctx.org.slug, id: c.id }}
              submitLabel={t("credentials.categories.archive")}
              successKey="credentials.categories.archived"
              variant="danger"
            />
          </RecordSection>
        </>
      ) : null}
      <RecordCollab page={page} table="app.credential_categories" id={c.id} canChange={canWrite} />
    </RecordChrome>
  );
}

/**
 * The category's Required before issue (B8, 6252): the courses and certifications a person must hold before it is
 * issued to them, from the org's Published courses and its certifications. Issuing to someone who does not meet one
 * is refused (credential_training_incomplete).
 */
async function RequirementsSection({
  page,
  categoryId,
  canWrite,
}: {
  page: ModulePage;
  categoryId: string;
  canWrite: boolean;
}) {
  const t = page.t;
  const db = page.ctx.viewer.db;
  const [requirements, courses, certifications] = await Promise.all([
    listCategoryRequirements(db, categoryId),
    canWrite ? listTrainingCourses(db, page.ctx.org.id) : Promise.resolve(null),
    canWrite ? listCertifications(db, page.ctx.org.id) : Promise.resolve(null),
  ]);
  const list: readonly CategoryRequirement[] = requirements.ok ? requirements.data : [];
  const taken = new Set(list.flatMap((r) => [r.trainingCourseId, r.certificationId]));
  const options = [
    ...(courses?.ok ? courses.data : [])
      .filter((c) => c.state === "Published" && !taken.has(c.id))
      .map((c) => ({
        value: `course:${c.id}`,
        label: `${t("credentials.requirements.course")}: ${c.title}`,
      })),
    ...(certifications?.ok ? certifications.data : [])
      .filter((c) => !taken.has(c.id))
      .map((c) => ({
        value: `certification:${c.id}`,
        label: `${t("credentials.requirements.certification")}: ${c.name}`,
      })),
  ];
  return (
    <RecordSection id="category-requirements" title={t("credentials.requirements.title")}>
      <p className="m-0 text-text-13 text-text-secondary">{t("credentials.requirements.what")}</p>
      <ResultRegion>
        {list.length === 0 ? (
          <p className="m-0 text-text-13">{t("credentials.requirements.empty")}</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-8 p-0 text-text-13">
            {list.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-8">
                <span>
                  {t(
                    r.trainingCourseId
                      ? "credentials.requirements.course"
                      : "credentials.requirements.certification",
                  )}
                  : {r.title}
                </span>
                {canWrite ? (
                  <ReportedActionForm
                    action={removeRequirementAction}
                    hidden={{ org: page.ctx.org.slug, id: r.id }}
                    submitLabel={t("credentials.requirements.remove")}
                    successKey="credentials.requirements.removed"
                    variant="ghost"
                    layout="inline"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </ResultRegion>
      {canWrite && options.length > 0 ? (
        <ActionForm
          action={addRequirementAction}
          hidden={{ org: page.ctx.org.slug, categoryId }}
          submitLabel={t("credentials.requirements.add")}
          variant="secondary"
          layout="inline"
        >
          <SelectField
            id={`requirement-${categoryId}`}
            name="requirement"
            label={t("credentials.requirements.kind")}
            options={options}
            required
          />
        </ActionForm>
      ) : null}
    </RecordSection>
  );
}

/** The chips of a credential's accreditation checks (B8, 6253), and none when nothing needs attention. */
// Access grid ------------------------------------------------------------------------------------

export async function AccessGridSection({ page }: { page: ModulePage }) {
  const t = page.t;
  const section = "access-grid";
  const format = await getFormatter();
  const { views, view } = chooseView("credentials.access-grid", param(page.search, "view"));
  const title = t("nav.atlas.pages.credentials.accessGrid");
  const header = <Header page={page} section={section} title={title} views={views} view={view} />;
  const project = page.project;
  if (!project) {
    return (
      <CollectionPage header={header}>
        <ProjectFilter page={page} section={section} />
        {chooseProjectNotice(page, section)}
      </CollectionPage>
    );
  }
  const db = page.ctx.viewer.db;
  const [categoriesResult, zonesResult, gridResult, levelsResult] = await Promise.all([
    listCredentialCategories(db, { orgId: page.ctx.org.id, projectId: project.id }),
    listProjectZones(db, page.ctx.org.id, project.venueId),
    listAccessGrid(db, page.ctx.org.id, project.id),
    listAccessLevels(db),
  ]);
  const categories = unwrap(categoriesResult, "credential categories");
  const zones = unwrap(zonesResult, "zones");
  const grid = unwrap(gridResult, "access grid");
  const levels = unwrap(levelsResult, "access levels");
  const editable = can(page, "credentials.access_grid.write");
  const levelLabel = (id: string) => levels.find((l) => l.id === id)?.label ?? id;

  if (categories.length === 0 || zones.length === 0) {
    return (
      <CollectionPage header={header}>
        <ProjectFilter page={page} section={section} />
        {categories.length === 0 ? (
          <EmptyStateLink
            icon="Grid3x3"
            sentence={t("credentials.grid.needsCategories")}
            actionLabel={t("credentials.categories.new")}
            href={
              `/${page.ctx.org.slug}/credentials/categories?project=${project.key}&create=1` as Route
            }
          />
        ) : (
          <EmptyStateLink
            icon="Grid3x3"
            sentence={t("credentials.grid.needsZones")}
            actionLabel={t("credentials.grid.openPlaces")}
            href={`/${page.ctx.org.slug}/places`}
          />
        )}
      </CollectionPage>
    );
  }

  // Matrix columns are named by zone code; a code two venues share also names its venue.
  const zoneLabel = (z: Zone) =>
    zones.filter((o) => o.code === z.code).length > 1 ? joined(z.code, z.venueName) : z.code;
  const grants = [
    ...new Set(
      grid.flatMap((g) => {
        const cat = categories.find((c) => c.id === g.categoryId);
        const zone = zones.find((z) => z.id === g.zoneId);
        return cat && zone ? [`${cat.code}|${zoneLabel(zone)}`] : [];
      }),
    ),
  ];
  const now = new Date();
  const defaultStart = now.toISOString();
  const defaultEnd = new Date(now.getTime() + 30 * 86_400_000).toISOString();
  const firstLevel = levels[0]?.id ?? "";

  const table = (
    <OpsTable
      caption={t("credentials.grid.tableCaption", { project: project.key })}
      columns={[
        {
          key: "category",
          label: t("credentials.issued.category"),
          primary: true,
          render: (g: AccessGridEntry) => categories.find((c) => c.id === g.categoryId)?.code ?? "",
        },
        {
          key: "zone",
          label: t("credentials.grid.zone"),
          primary: true,
          render: (g: AccessGridEntry) => `${g.zoneCode} · ${g.zoneName}`,
        },
        {
          key: "level",
          label: t("credentials.grid.level"),
          primary: true,
          render: (g: AccessGridEntry) => levelLabel(g.accessLevelId),
        },
        {
          key: "starts",
          label: t("credentials.grid.opens"),
          render: (g: AccessGridEntry) => dateTime(format, g.windowStartsAt, project.timeZone),
        },
        {
          key: "ends",
          label: t("credentials.grid.closes"),
          render: (g: AccessGridEntry) => dateTime(format, g.windowEndsAt, project.timeZone),
        },
      ]}
      rows={grid}
      rowKey={(g) => g.id}
    />
  );

  return (
    <CollectionPage header={header}>
      <ProjectFilter page={page} section={section} />
      <p className="m-0 text-text-13 text-text-secondary">{t("credentials.grid.explain")}</p>
      {view === "matrix" ? (
        <>
          {editable ? (
            <>
              <AccessMatrixEditor
                org={page.ctx.org.slug}
                projectId={project.id}
                label={t("credentials.grid.matrixLabel", { project: project.key })}
                zones={zones.map((z) => ({ id: z.id, label: zoneLabel(z) }))}
                categories={categories.map((c) => ({ id: c.id, label: c.code }))}
                grants={grants}
                editable
                accessLevelId={firstLevel}
                windowStartsAt={defaultStart}
                windowEndsAt={defaultEnd}
              />
              <p className="m-0 text-text-12 text-text-secondary">
                {t("credentials.grid.matrixHelp", { level: levelLabel(firstLevel) })}
              </p>
            </>
          ) : null}
          {grid.length > 0 ? (
            <details open={!editable}>
              <summary className="cursor-pointer text-text-13 text-text-secondary">
                {t("credentials.grid.tableAlternative")}
              </summary>
              <div className="pt-8">{table}</div>
            </details>
          ) : (
            <p className="m-0 text-text-13 text-text-secondary">{t("credentials.grid.empty")}</p>
          )}
        </>
      ) : (
        <>
          {grid.length > 0 ? (
            <div className="flex flex-col gap-12">
              {grid.map((g) => {
                const cat = categories.find((c) => c.id === g.categoryId);
                return (
                  <section
                    key={g.id}
                    aria-label={`${cat?.code ?? ""} · ${g.zoneCode}`}
                    className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
                  >
                    <h2 className="m-0 text-text-14 font-semibold">
                      {joined(cat?.code, g.zoneCode, g.zoneName)}
                    </h2>
                    {editable ? (
                      <div className="flex flex-wrap items-end gap-12">
                        <ActionForm
                          action={updateZoneAccessAction}
                          hidden={{ org: page.ctx.org.slug, id: g.id, timeZone: project.timeZone }}
                          submitLabel={t("credentials.common.save")}
                          successKey="credentials.common.saved"
                          layout="inline"
                          variant="secondary"
                        >
                          <SelectField
                            id={`level-${g.id}`}
                            name="accessLevelId"
                            label={t("credentials.grid.level")}
                            options={levels.map((l) => ({ value: l.id, label: l.label }))}
                            defaultValue={g.accessLevelId}
                          />
                          <TextField
                            id={`opens-${g.id}`}
                            name="windowStartsAt"
                            type="datetime-local"
                            required
                            label={t("credentials.grid.opens")}
                            defaultValue={instantToLocal(g.windowStartsAt, project.timeZone)}
                          />
                          <TextField
                            id={`closes-${g.id}`}
                            name="windowEndsAt"
                            type="datetime-local"
                            required
                            label={t("credentials.grid.closes")}
                            defaultValue={instantToLocal(g.windowEndsAt, project.timeZone)}
                          />
                        </ActionForm>
                        <ActionForm
                          action={withdrawZoneAccessAction}
                          hidden={{ org: page.ctx.org.slug, id: g.id }}
                          submitLabel={t("credentials.grid.withdraw")}
                          successKey="credentials.grid.withdrawn"
                          variant="ghost"
                        />
                      </div>
                    ) : (
                      <Properties
                        label={t("credentials.common.properties")}
                        rows={[
                          {
                            label: t("credentials.grid.level"),
                            value: levelLabel(g.accessLevelId),
                          },
                          {
                            label: t("credentials.grid.opens"),
                            value: dateTime(format, g.windowStartsAt, project.timeZone),
                          },
                          {
                            label: t("credentials.grid.closes"),
                            value: dateTime(format, g.windowEndsAt, project.timeZone),
                          },
                        ]}
                      />
                    )}
                  </section>
                );
              })}
            </div>
          ) : (
            <p className="m-0 text-text-13 text-text-secondary">{t("credentials.grid.empty")}</p>
          )}
          {editable ? (
            <RecordSection id="grid-add" title={t("credentials.grid.addHeading")}>
              <ActionForm
                action={grantZoneAccessAction}
                hidden={{
                  org: page.ctx.org.slug,
                  projectId: project.id,
                  timeZone: project.timeZone,
                }}
                submitLabel={t("credentials.grid.grant")}
                successKey="credentials.grid.granted"
                layout="inline"
              >
                <SelectField
                  id="grid-category"
                  name="categoryId"
                  label={t("credentials.issued.category")}
                  options={categories.map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))}
                  required
                />
                <SelectField
                  id="grid-zone"
                  name="zoneId"
                  label={t("credentials.grid.zone")}
                  options={zones.map((z) => ({
                    value: z.id,
                    label: joined(z.code, z.name, z.venueName),
                  }))}
                  required
                />
                <SelectField
                  id="grid-level"
                  name="accessLevelId"
                  label={t("credentials.grid.level")}
                  options={levels.map((l) => ({ value: l.id, label: l.label }))}
                  required
                />
                <TextField
                  id="grid-opens"
                  name="windowStartsAt"
                  type="datetime-local"
                  required
                  label={t("credentials.grid.opens")}
                  defaultValue={instantToLocal(defaultStart, project.timeZone)}
                  help={t("credentials.common.timeZoneHelp", { zone: project.timeZone })}
                />
                <TextField
                  id="grid-closes"
                  name="windowEndsAt"
                  type="datetime-local"
                  required
                  label={t("credentials.grid.closes")}
                  defaultValue={instantToLocal(defaultEnd, project.timeZone)}
                />
              </ActionForm>
            </RecordSection>
          ) : null}
        </>
      )}
    </CollectionPage>
  );
}
