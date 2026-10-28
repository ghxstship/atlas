import {
  CREDENTIAL_STATUSES,
  credentialStatus,
  getCredentialCategory,
  getIssuedCredential,
  listAccessGrid,
  listAccessLevels,
  listAccessScans,
  listCredentialCategories,
  listIssuedCredentials,
  listProjectZones,
  type AccessGridEntry,
  type AccessScan,
  type CredentialCategory,
  type CredentialStatus,
  type IssuedCredential,
  type OperationsProject,
  type Zone,
} from "@xos/data/credentials";
import { listMembers } from "@xos/data";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import type { ReactNode } from "react";
import {
  chooseProjectNotice,
  dateTime,
  Header,
  ProjectFilter,
  RecordChrome,
  RecordMissing,
  sectionHref,
  unwrap,
  type Format,
} from "@/components/operations/chrome";
import { ActionForm } from "@/components/operations/action-form";
import { SelectField, TextField } from "@/components/operations/fields";
import {
  joined,
  OpsBoard,
  OpsList,
  OpsTable,
  param,
  Properties,
  RecordSection,
  ToneChip,
  type Column,
} from "@/components/operations/kit";
import { RecordCollab } from "@/components/operations/record-collab";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import {
  archiveCategoryAction,
  createCategoryAction,
  grantZoneAccessAction,
  issueCredentialAction,
  recordScanAction,
  revokeCredentialAction,
  updateCategoryAction,
  updateWindowAction,
  updateZoneAccessAction,
  withdrawZoneAccessAction,
} from "@/lib/credentials/actions";
import { can, chooseView, type ModulePage } from "@/lib/operations/context";
import { instantToLocal } from "@/lib/operations/time";
import { AccessMatrixEditor, CredentialBadge } from "./client";
import { ScanIntakeQueue } from "./scan-intake";
import { DocumentActions } from "@/components/documents/document-actions";
import { CollectionPage } from "@/components/platform/collection-page";

/**
 * The Credentials module (Section 4.2: categories, issuance, the access grid and scans), one
 * section per sitemap page. Each section renders the Collection template: header with the view
 * switcher and primary action, the filter bar, the view, and the side peek or full page of the
 * record named in the URL. The org pages and the project tab share these sections.
 */

const STATUS_TONE: Record<CredentialStatus, "success" | "accent" | "neutral" | "danger"> = {
  active: "success",
  scheduled: "accent",
  expired: "neutral",
  revoked: "danger",
};

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

// Issued -----------------------------------------------------------------------------------------

export async function IssuedSection({ page }: { page: ModulePage }) {
  const t = page.t;
  const section = "issued";
  const format = await getFormatter();
  const { views, view } = chooseView("credentials.issued", param(page.search, "view"));
  const statusFilter = param(page.search, "status") as CredentialStatus | undefined;
  const categoryFilter = param(page.search, "category");
  const [all, categories] = await Promise.all([
    listIssuedCredentials(page.ctx.viewer.db, {
      orgId: page.ctx.org.id,
      ...(page.project ? { projectId: page.project.id } : {}),
      ...(categoryFilter ? { categoryId: categoryFilter } : {}),
    }),
    listCredentialCategories(page.ctx.viewer.db, {
      orgId: page.ctx.org.id,
      ...(page.project ? { projectId: page.project.id } : {}),
    }),
  ]);
  const now = new Date();
  const issued = unwrap(all, "issued credentials").filter(
    (c) => !statusFilter || credentialStatus(c, now) === statusFilter,
  );
  const categoryList = unwrap(categories, "credential categories");
  const peekId = param(page.search, "peek");
  const creating = param(page.search, "create") === "1";
  const canIssue = can(page, "credentials.credential.issue");
  const title = t("nav.atlas.pages.credentials.issued");
  const peekHref = (c: IssuedCredential) =>
    sectionHref(page, { peek: c.id, full: undefined, create: undefined, section });
  const status = (c: IssuedCredential) => {
    const s = credentialStatus(c, now);
    return <ToneChip tone={STATUS_TONE[s]}>{t(`credentials.issued.status.${s}`)}</ToneChip>;
  };
  const holder = (c: IssuedCredential) => c.holderName ?? t("credentials.common.unnamed");

  const columns: Column<IssuedCredential>[] = [
    {
      key: "number",
      label: t("credentials.issued.number"),
      primary: true,
      render: (c) => <span className="font-mono">{c.number}</span>,
    },
    { key: "holder", label: t("credentials.issued.holder"), primary: true, render: holder },
    {
      key: "category",
      label: t("credentials.issued.category"),
      render: (c) => `${c.categoryCode} · ${c.categoryName}`,
    },
    { key: "project", label: t("credentials.common.project"), render: (c) => c.projectKey },
    {
      key: "validTo",
      label: t("credentials.issued.validTo"),
      render: (c) => (c.validTo ? dateTime(format, c.validTo) : t("credentials.issued.openEnded")),
    },
    { key: "status", label: t("credentials.issued.statusLabel"), primary: true, render: status },
  ];

  let body: ReactNode;
  if (issued.length === 0) {
    body = (
      <EmptyStateLink
        icon="IdCard"
        sentence={t(
          statusFilter || categoryFilter
            ? "credentials.issued.emptyFiltered"
            : "credentials.issued.empty",
        )}
        actionLabel={t("credentials.issued.new")}
        href={sectionHref(page, { create: "1", section })}
      />
    );
  } else if (view === "board") {
    body = (
      <OpsBoard
        label={title}
        columns={CREDENTIAL_STATUSES.map((s) => ({
          key: s,
          label: t(`credentials.issued.status.${s}`),
          empty: t("credentials.issued.boardEmpty"),
          items: issued
            .filter((c) => credentialStatus(c, now) === s)
            .map((c) => ({
              key: c.id,
              href: peekHref(c),
              title: holder(c),
              meta: `${c.number} · ${c.categoryCode}`,
            })),
        }))}
      />
    );
  } else if (view === "list") {
    body = (
      <OpsList
        label={title}
        items={issued.map((c) => ({
          key: c.id,
          href: peekHref(c),
          title: holder(c),
          meta: `${c.number} · ${c.categoryCode} · ${c.projectKey}`,
          trailing: status(c),
        }))}
      />
    );
  } else {
    body = (
      <OpsTable
        caption={title}
        columns={columns}
        rows={issued}
        rowKey={(c) => c.id}
        rowHref={peekHref}
        selected={peekId}
      />
    );
  }

  return (
    <CollectionPage
      header={
        <Header
          page={page}
          section={section}
          title={title}
          count={issued.length}
          views={views}
          view={view}
          action={
            canIssue ? (
              <ButtonLink
                href={sectionHref(page, { create: "1", peek: undefined, section })}
                variant="primary"
              >
                {t("credentials.issued.new")}
              </ButtonLink>
            ) : undefined
          }
        />
      }
    >
      <ProjectFilter
        page={page}
        section={section}
        extra={[
          {
            name: "status",
            label: t("credentials.issued.statusLabel"),
            value: statusFilter ?? "",
            options: [
              { value: "", label: t("credentials.issued.anyStatus") },
              ...CREDENTIAL_STATUSES.map((s) => ({
                value: s,
                label: t(`credentials.issued.status.${s}`),
              })),
            ],
          },
        ]}
      />
      {creating && canIssue ? (
        page.project ? (
          <IssueForm page={page} project={page.project} categories={categoryList} />
        ) : (
          chooseProjectNotice(page, section)
        )
      ) : null}
      {body}
      {peekId ? <CredentialRecord page={page} id={peekId} section={section} /> : null}
    </CollectionPage>
  );
}

async function IssueForm({
  page,
  project,
  categories,
}: {
  page: ModulePage;
  project: OperationsProject;
  categories: readonly CredentialCategory[];
}) {
  const t = page.t;
  if (categories.length === 0) {
    return (
      <EmptyStateLink
        icon="IdCard"
        sentence={t("credentials.issued.needsCategory")}
        actionLabel={t("credentials.categories.new")}
        href={
          `/${page.ctx.org.slug}/credentials/categories?project=${project.key}&create=1` as Route
        }
      />
    );
  }
  const members = unwrap(await listMembers(page.ctx.viewer.db, page.ctx.org.id), "members");
  const me = page.ctx.viewer.person?.id;
  const holders = members.filter((m) => m.personId !== me);
  return (
    <RecordSection id="issue-credential" title={t("credentials.issued.new")}>
      <ActionForm
        action={issueCredentialAction}
        hidden={{ org: page.ctx.org.slug, projectId: project.id, timeZone: project.timeZone }}
        submitLabel={t("credentials.issued.issue")}
        successKey="credentials.issued.issuedAs"
        layout="inline"
        resetOnSuccess
      >
        <SelectField
          id="issue-category"
          name="categoryId"
          label={t("credentials.issued.category")}
          options={categories.map((c) => ({ value: c.id, label: `${c.code} · ${c.name}` }))}
          required
        />
        <SelectField
          id="issue-holder"
          name="holderPersonId"
          label={t("credentials.issued.holder")}
          help={t("credentials.issued.holderHelp")}
          options={holders.map((m) => ({
            value: m.personId,
            label: m.fullName ?? t("credentials.common.unnamed"),
          }))}
          required
        />
        <TextField
          id="issue-from"
          name="validFrom"
          type="datetime-local"
          label={t("credentials.issued.validFrom")}
          help={t("credentials.common.timeZoneHelp", { zone: project.timeZone })}
        />
        <TextField
          id="issue-to"
          name="validTo"
          type="datetime-local"
          label={t("credentials.issued.validTo")}
          help={t("credentials.issued.validToHelp")}
        />
      </ActionForm>
    </RecordSection>
  );
}

async function CredentialRecord({
  page,
  id,
  section,
}: {
  page: ModulePage;
  id: string;
  section: string;
}) {
  const t = page.t;
  const format = await getFormatter();
  const closeHref = sectionHref(page, { peek: undefined, full: undefined, section });
  const result = await getIssuedCredential(page.ctx.viewer.db, id);
  if (!result.ok) return <RecordMissing page={page} closeHref={closeHref} />;
  const c = result.data;
  const project = page.projects.find((p) => p.id === c.projectId);
  const timeZone = project?.timeZone ?? "UTC";
  const [scans, grid] = await Promise.all([
    listAccessScans(page.ctx.viewer.db, { orgId: page.ctx.org.id, credentialId: c.id, limit: 20 }),
    project
      ? listAccessGrid(page.ctx.viewer.db, page.ctx.org.id, project.id)
      : Promise.resolve(null),
  ]);
  const status = credentialStatus(c);
  const zones = grid?.ok
    ? [...new Set(grid.data.filter((g) => g.categoryId === c.categoryId).map((g) => g.zoneCode))]
    : [];
  const canRevoke = can(page, "credentials.credential.revoke") && status !== "revoked";
  const canEdit = can(page, "credentials.credential.issue") && status !== "revoked";
  return (
    <RecordChrome
      page={page}
      full={param(page.search, "full") === "1"}
      title={c.holderName ?? t("credentials.common.unnamed")}
      recordKey={c.number}
      kindLabel={t("credentials.issued.kind")}
      closeHref={closeHref}
      fullHref={sectionHref(page, { peek: c.id, full: "1", section })}
      properties={
        <Properties
          label={t("credentials.common.properties")}
          rows={[
            {
              label: t("credentials.issued.statusLabel"),
              value: (
                <ToneChip tone={STATUS_TONE[status]}>
                  {t(`credentials.issued.status.${status}`)}
                </ToneChip>
              ),
            },
            {
              label: t("credentials.issued.category"),
              value: `${c.categoryCode} · ${c.categoryName}`,
            },
            { label: t("credentials.common.project"), value: c.projectKey },
            {
              label: t("credentials.issued.validFrom"),
              value: dateTime(format, c.validFrom, timeZone),
            },
            {
              label: t("credentials.issued.validTo"),
              value: c.validTo
                ? dateTime(format, c.validTo, timeZone)
                : t("credentials.issued.openEnded"),
            },
            {
              label: t("credentials.issued.issuedBy"),
              value: c.issuedByName ?? t("credentials.common.unnamed"),
            },
            ...(c.revokedAt
              ? [
                  {
                    label: t("credentials.issued.revokedAt"),
                    value: `${dateTime(format, c.revokedAt, timeZone)} · ${c.revokedByName ?? ""}`,
                  },
                ]
              : []),
          ]}
        />
      }
    >
      <RecordSection id="credential-badge" title={t("credentials.issued.badge")}>
        <CredentialBadge
          org={page.ctx.org.name}
          name={c.holderName ?? t("credentials.common.unnamed")}
          role={c.categoryName}
          category={c.categoryCode}
          categoryColor={1}
          credentialKey={c.number}
          payload={c.number}
          zones={zones}
          validFrom={dateTime(format, c.validFrom, timeZone)}
          validTo={
            c.validTo ? dateTime(format, c.validTo, timeZone) : t("credentials.issued.openEnded")
          }
        />
        <DocumentActions org={page.ctx.org.slug} kind="credential-badge" id={c.id} />
      </RecordSection>
      {canEdit ? (
        <RecordSection id="credential-window" title={t("credentials.issued.windowHeading")}>
          <ActionForm
            action={updateWindowAction}
            hidden={{ org: page.ctx.org.slug, id: c.id, timeZone }}
            submitLabel={t("credentials.common.save")}
            successKey="credentials.common.saved"
            layout="inline"
          >
            <TextField
              id="window-from"
              name="validFrom"
              type="datetime-local"
              required
              label={t("credentials.issued.validFrom")}
              defaultValue={instantToLocal(c.validFrom, timeZone)}
              help={t("credentials.common.timeZoneHelp", { zone: timeZone })}
            />
            <TextField
              id="window-to"
              name="validTo"
              type="datetime-local"
              label={t("credentials.issued.validTo")}
              defaultValue={instantToLocal(c.validTo, timeZone)}
              help={t("credentials.issued.validToHelp")}
            />
          </ActionForm>
        </RecordSection>
      ) : null}
      {canRevoke ? (
        <RecordSection id="credential-revoke" title={t("credentials.issued.revokeHeading")}>
          <ActionForm
            action={revokeCredentialAction}
            hidden={{ org: page.ctx.org.slug, id: c.id }}
            submitLabel={t("credentials.issued.revoke")}
            successKey="credentials.issued.revoked"
            variant="danger"
          >
            <label className="flex items-center gap-8 text-text-13">
              <input type="checkbox" name="confirm" required className="size-16" />
              {t("credentials.issued.revokeConfirm", { number: c.number })}
            </label>
          </ActionForm>
        </RecordSection>
      ) : null}
      <RecordSection id="credential-scans" title={t("credentials.issued.recentScans")}>
        {scans.ok && scans.data.length > 0 ? (
          <ScanRows page={page} scans={scans.data} format={format} />
        ) : (
          <p className="m-0 text-text-13 text-text-secondary">
            {scans.ok ? t("credentials.issued.noScans") : t("credentials.issued.scansHidden")}
          </p>
        )}
      </RecordSection>
      <RecordCollab
        page={page}
        table="app.credentials"
        id={c.id}
        canChange={can(page, "credentials.credential.issue")}
      />
    </RecordChrome>
  );
}

function ScanRows({
  page,
  scans,
  format,
}: {
  page: ModulePage;
  scans: readonly AccessScan[];
  format: Format;
}) {
  return (
    <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
      {scans.map((s) => (
        <li
          key={s.id}
          className="flex flex-wrap items-center justify-between gap-8 py-6 text-text-13"
        >
          <span>{joined(s.zoneCode, dateTime(format, s.scannedAt))}</span>
          <ResultChip page={page} result={s.result} />
        </li>
      ))}
    </ul>
  );
}

function ResultChip({ page, result }: { page: ModulePage; result: AccessScan["result"] }) {
  return (
    <ToneChip tone={result === "Granted" ? "success" : "danger"}>
      {page.t(result === "Granted" ? "credentials.scans.granted" : "credentials.scans.denied")}
    </ToneChip>
  );
}

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

// Scan log ---------------------------------------------------------------------------------------

export async function ScanLogSection({ page }: { page: ModulePage }) {
  const t = page.t;
  const section = "scan-log";
  const format = await getFormatter();
  const { views, view } = chooseView("credentials.scan-log", param(page.search, "view"));
  const resultFilter = param(page.search, "result");
  const scanResult =
    resultFilter === "Granted" || resultFilter === "Denied" ? resultFilter : undefined;
  const scans = unwrap(
    await listAccessScans(page.ctx.viewer.db, {
      orgId: page.ctx.org.id,
      ...(page.project ? { projectId: page.project.id } : {}),
      ...(scanResult ? { result: scanResult } : {}),
    }),
    "scans",
  );
  const title = t("nav.atlas.pages.credentials.scanLog");
  const canScan = can(page, "credentials.scan.write");
  const zones =
    page.project && canScan
      ? unwrap(
          await listProjectZones(page.ctx.viewer.db, page.ctx.org.id, page.project.venueId),
          "zones",
        )
      : [];
  const timeZone = page.project?.timeZone;

  const columns: Column<AccessScan>[] = [
    {
      key: "when",
      label: t("credentials.scans.when"),
      primary: true,
      render: (s) => dateTime(format, s.scannedAt, timeZone),
    },
    {
      key: "number",
      label: t("credentials.issued.number"),
      render: (s) => <span className="font-mono">{s.credentialNumber}</span>,
    },
    {
      key: "holder",
      label: t("credentials.issued.holder"),
      primary: true,
      render: (s) => s.holderName ?? t("credentials.common.unnamed"),
    },
    {
      key: "zone",
      label: t("credentials.grid.zone"),
      render: (s) => `${s.zoneCode} · ${s.zoneName}`,
    },
    { key: "project", label: t("credentials.common.project"), render: (s) => s.projectKey },
    {
      key: "result",
      label: t("credentials.scans.result"),
      primary: true,
      render: (s) => <ResultChip page={page} result={s.result} />,
    },
  ];

  return (
    <CollectionPage
      header={
        <Header
          page={page}
          section={section}
          title={title}
          count={scans.length}
          views={views}
          view={view}
        />
      }
    >
      <ProjectFilter
        page={page}
        section={section}
        extra={[
          {
            name: "result",
            label: t("credentials.scans.result"),
            value: scanResult ?? "",
            options: [
              { value: "", label: t("credentials.scans.anyResult") },
              { value: "Granted", label: t("credentials.scans.granted") },
              { value: "Denied", label: t("credentials.scans.denied") },
            ],
          },
        ]}
      />
      {canScan && page.project && zones.length > 0 ? (
        <RecordSection id="scan-desk" title={t("credentials.scans.deskHeading")}>
          <p className="m-0 text-text-13 text-text-secondary">{t("credentials.scans.deskHelp")}</p>
          <ActionForm
            action={recordScanAction}
            hidden={{ org: page.ctx.org.slug }}
            submitLabel={t("credentials.scans.check")}
            successKey="credentials.scans.decided"
            layout="inline"
            resetOnSuccess
          >
            <SelectField
              id="scan-zone"
              name="zoneId"
              label={t("credentials.grid.zone")}
              options={zones.map((z) => ({
                value: z.id,
                label: joined(z.code, z.name, z.venueName),
              }))}
              required
            />
            <TextField
              id="scan-number"
              name="credentialNumber"
              label={t("credentials.scans.number")}
              help={t("credentials.scans.numberHelp")}
              required
              maxLength={40}
            />
          </ActionForm>
        </RecordSection>
      ) : null}
      <ScanIntakeQueue page={page} />
      {scans.length === 0 ? (
        <EmptyStateLink
          icon="ScanLine"
          sentence={t(scanResult ? "credentials.scans.emptyFiltered" : "credentials.scans.empty")}
          actionLabel={t("credentials.scans.toIssued")}
          href={
            `/${page.ctx.org.slug}/credentials/issued${page.project ? `?project=${page.project.key}` : ""}` as Route
          }
        />
      ) : view === "list" ? (
        <OpsList
          label={title}
          items={scans.map((s) => ({
            key: s.id,
            href: `/${page.ctx.org.slug}/credentials/issued?project=${s.projectKey}&peek=${s.credentialId}` as Route,
            title: `${s.holderName ?? t("credentials.common.unnamed")} · ${s.zoneCode}`,
            meta: `${s.credentialNumber} · ${dateTime(format, s.scannedAt, timeZone)}`,
            trailing: <ResultChip page={page} result={s.result} />,
          }))}
        />
      ) : (
        <OpsTable
          caption={title}
          columns={columns}
          rows={scans}
          rowKey={(s) => s.id}
          rowHref={(s) =>
            `/${page.ctx.org.slug}/credentials/issued?project=${s.projectKey}&peek=${s.credentialId}` as Route
          }
        />
      )}
    </CollectionPage>
  );
}
