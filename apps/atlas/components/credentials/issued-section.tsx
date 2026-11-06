import { approvalBySubject, listSubjectApprovals, type SubjectApproval } from "@xos/data/workflow";
import {
  CREDENTIAL_STATUSES,
  credentialBookingsElsewhere,
  credentialReviews,
  credentialStatus,
  getIssuedCredential,
  listAccessGrid,
  listAccessScans,
  listCategoryRequirements,
  listCredentialCategories,
  listIssuedCredentials,
  needsAttention,
  type CredentialCategory,
  type CredentialReview,
  type CredentialStatus,
  type IssuedCredential,
  type OperationsProject,
} from "@xos/data/credentials";
import { approvalBySubject, listSubjectApprovals, type SubjectApproval } from "@xos/data/workflow";
import { badgePhotos, badgePhotoThumbnail } from "@xos/data/credential-photos";
import { printSizesFor } from "@xos/data/documents/model";
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
import { projectPeople, projectPersonLabel } from "@/lib/people/project-people";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import {
  issueCredentialAction,
  removeCredentialPhotoAction,
  requestCredentialPhotosAction,
  revokeCredentialAction,
  updateWindowAction,
} from "@/lib/credentials/actions";
import { can, chooseView, type ModulePage } from "@/lib/operations/context";
import { instantToLocal } from "@/lib/operations/time";
import { InlineAlert } from "@/components/collection-kit/ui";
import { CredentialBadge } from "./client";
import { DocumentActions } from "@/components/documents/document-actions";
import { CollectionPage } from "@/components/platform/collection-page";
import { env } from "@/lib/env";
import { gatewayUrl } from "@/lib/gateway-url";
import { BadgePrint, PHOTO_TONE } from "./badge-print";
import { IssueChecks } from "./issue-checks";
import { ScanRows } from "./scan-rows";

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

function CheckChips({ page, review }: { page: ModulePage; review: CredentialReview | undefined }) {
  if (!review) return null;
  const t = page.t;
  const chips: { key: string; tone: "danger" | "warning"; label: string }[] = [];
  if (review.duplicateLive)
    chips.push({ key: "dup", tone: "danger", label: t("credentials.checks.chips.duplicate") });
  if (review.missingRequirements > 0)
    chips.push({ key: "train", tone: "danger", label: t("credentials.checks.chips.training") });
  if (review.otherBadgesOnProject > 0)
    chips.push({ key: "other", tone: "warning", label: t("credentials.checks.chips.otherBadge") });
  if (review.sameNameOnProject > 0)
    chips.push({ key: "name", tone: "warning", label: t("credentials.checks.chips.sameName") });
  if (review.bookedElsewhere)
    chips.push({
      key: "booked",
      tone: "warning",
      label: t("credentials.checks.chips.bookedElsewhere"),
    });
  if (chips.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-4">
      {chips.map((c) => (
        <ToneChip key={c.key} tone={c.tone}>
          {c.label}
        </ToneChip>
      ))}
    </span>
  );
}

// Issued -----------------------------------------------------------------------------------------

const APPROVAL_TONE = { "In Review": "warning", Approved: "success", Rejected: "danger" } as const;

/** A pass's approval state (P9): Awaiting approval, Approved or Rejected; nothing without one, or once withdrawn. */
function approvalChip(t: ModulePage["t"], a: SubjectApproval | undefined): ReactNode {
  if (!a || a.state === "Canceled") return null;
  const key =
    a.state === "In Review" ? "waiting" : a.state === "Approved" ? "approved" : "rejected";
  return (
    <ToneChip tone={APPROVAL_TONE[a.state]}>{t(`credentials.issued.approval.${key}`)}</ToneChip>
  );
}

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
  const attention = param(page.search, "attention") === "1";
  const listed = unwrap(all, "issued credentials").filter(
    (c) => !statusFilter || credentialStatus(c, now) === statusFilter,
  );
  // The accreditation checks of the listed credentials (6253). The page still lists without them, says so, and does not
  // filter on them, because an empty Needs attention would read as nothing needing attention.
  const reviewResult = await credentialReviews(
    page.ctx.viewer.db,
    listed.map((c) => c.id),
  );
  const reviews: ReadonlyMap<string, CredentialReview> = reviewResult.ok
    ? reviewResult.data
    : new Map();
  const issued =
    attention && reviewResult.ok
      ? listed.filter((c) => {
          const r = reviews.get(c.id);
          return r !== undefined && needsAttention(r);
        })
      : listed;
  // P9: a pass a project's approval rule holds scans Denied until approved (5860); its state shows beside the status.
  const approvals = await listSubjectApprovals(page.ctx.viewer.db, {
    credentialIds: issued.map((c) => c.id),
  });
  const approvalOf = approvalBySubject(approvals.ok ? approvals.data : []);
  const categoryList = unwrap(categories, "credential categories");
  const peekId = param(page.search, "peek");
  const creating = param(page.search, "create") === "1";
  const printing = param(page.search, "print") === "1";
  const canIssue = can(page, "credentials.credential.issue");
  const title = t("nav.atlas.pages.credentials.issued");
  const peekHref = (c: IssuedCredential) =>
    sectionHref(page, { peek: c.id, full: undefined, create: undefined, section });
  const status = (c: IssuedCredential) => {
    const s = credentialStatus(c, now);
    return <ToneChip tone={STATUS_TONE[s]}>{t(`credentials.issued.status.${s}`)}</ToneChip>;
  };
  const holder = (c: IssuedCredential) => c.holderName ?? t("credentials.common.unnamed");
  const approval = (c: IssuedCredential) => approvalChip(t, approvalOf.get(c.id));

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
    { key: "approval", label: t("credentials.issued.approval.label"), render: approval },
    {
      key: "source",
      label: t("credentials.sources.title"),
      render: (c) => {
        const r = reviews.get(c.id);
        return r ? t(`credentials.sources.${r.holderSource}`) : "";
      },
    },
    {
      key: "checks",
      label: t("credentials.checks.title"),
      render: (c) => <CheckChips page={page} review={reviews.get(c.id)} />,
    },
  ];

  let body: ReactNode;
  if (issued.length === 0) {
    body = (
      <EmptyStateLink
        icon="IdCard"
        sentence={t(
          statusFilter || categoryFilter || attention
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
          trailing: (
            <span className="flex flex-wrap items-center gap-4">
              {approval(c)}
              {status(c)}
            </span>
          ),
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
            <span className="inline-flex flex-wrap items-center gap-8">
              {issued.length > 0 ? (
                <ButtonLink
                  href={sectionHref(page, {
                    print: "1",
                    peek: undefined,
                    create: undefined,
                    section,
                  })}
                >
                  {t("credentials.print.action")}
                </ButtonLink>
              ) : null}
              {canIssue ? (
                <ButtonLink
                  href={sectionHref(page, { create: "1", peek: undefined, section })}
                  variant="primary"
                >
                  {t("credentials.issued.new")}
                </ButtonLink>
              ) : null}
            </span>
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
          {
            name: "attention",
            label: t("credentials.checks.needsAttention"),
            value: attention ? "1" : "",
            options: [
              { value: "", label: t("credentials.checks.anyCheck") },
              { value: "1", label: t("credentials.checks.needsAttention") },
            ],
          },
        ]}
      />
      {reviewResult.ok ? null : (
        <InlineAlert tone="warning">{t("credentials.checks.unavailable")}</InlineAlert>
      )}
      {creating && canIssue ? (
        page.project ? (
          <IssueForm page={page} project={page.project} categories={categoryList} />
        ) : (
          chooseProjectNotice(page, section)
        )
      ) : null}
      {printing ? <BadgePrint page={page} credentials={issued} section={section} /> : null}
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
  // Members and the people engaged on the project (R1); a badge under an engagement names its person.
  const me = page.ctx.viewer.person?.id;
  const [people, requirementLists] = await Promise.all([
    projectPeople(page.ctx, project.id),
    Promise.all(categories.map((c) => listCategoryRequirements(page.ctx.viewer.db, c.id))),
  ]);
  const holders = people.filter((p) => p.personId !== me);
  // Each requirement's link in the checks: its course on Training, or Certifications.
  const requirementHrefs: Record<string, string> = {};
  for (const r of requirementLists.flatMap((l) => (l.ok ? l.data : []))) {
    requirementHrefs[r.id] = r.trainingCourseId
      ? `/${page.ctx.org.slug}/knowledge/training?peek=${r.trainingCourseId}`
      : `/${page.ctx.org.slug}/people/certifications?peek=${r.certificationId}`;
  }
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
          options={holders.map((p) => ({
            value: p.personId,
            label: projectPersonLabel(t, p, t("credentials.common.unnamed")),
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
        <IssueChecks
          org={page.ctx.org.slug}
          timeZone={project.timeZone}
          requirementHrefs={requirementHrefs}
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
  const [scans, grid, bookings] = await Promise.all([
    listAccessScans(page.ctx.viewer.db, { orgId: page.ctx.org.id, credentialId: c.id, limit: 20 }),
    project
      ? listAccessGrid(page.ctx.viewer.db, page.ctx.org.id, project.id)
      : Promise.resolve(null),
    credentialBookingsElsewhere(page.ctx.viewer.db, c.id),
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
        <DocumentActions
          org={page.ctx.org.slug}
          kind="credential-badge"
          id={c.id}
          sizes={printSizesFor("credential-badge")}
        />
      </RecordSection>
      <BadgePhotoSection page={page} credential={c} timeZone={timeZone} />
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
      {bookings.ok && bookings.data.length > 0 ? (
        <RecordSection id="credential-bookings" title={t("credentials.checks.bookingsTitle")}>
          <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
            {bookings.data.map((b, i) => (
              <li key={`${b.projectId ?? "other"}-${b.kind}-${i}`}>
                {joined(
                  b.projectKey ?? t("credentials.checks.anotherProduction"),
                  t(`credentials.checks.bookingKinds.${b.kind}`),
                  b.startsAt ? dateTime(format, b.startsAt, timeZone) : null,
                  b.endsAt ? dateTime(format, b.endsAt, timeZone) : null,
                )}
              </li>
            ))}
          </ul>
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

/**
 * The badge photo of a credential (P5): the photo its badge prints and where it came from, with a thumbnail, and
 * for issuers a request to the holder, the Gateway link to send them, and removal once the photo's scan finished (an
 * issuer cannot delete an object before it scans Clean, 5821). A revoked or expired credential prints no photo, so it
 * shows only that.
 */
async function BadgePhotoSection({
  page,
  credential: c,
  timeZone,
}: {
  page: ModulePage;
  credential: IssuedCredential;
  timeZone: string;
}) {
  const t = page.t;
  const format = await getFormatter();
  const rows = await badgePhotos(page.ctx.viewer.db, [c.id]);
  const row = rows.ok ? rows.data[0] : undefined;
  const name = c.holderName ?? t("credentials.common.unnamed");
  if (!row) {
    return (
      <RecordSection id="credential-photo" title={t("credentials.photo.heading")}>
        <p className="m-0 text-text-13 text-text-secondary">{t("credentials.photo.notLive")}</p>
      </RecordSection>
    );
  }
  const thumbnail = await badgePhotoThumbnail(page.ctx.viewer.db, row);
  const canIssue = can(page, "credentials.credential.issue");
  const link = env().GATEWAY_SITE_URL ? gatewayUrl("/profile/badge-photos") : null;
  const when = row.providedAt
    ? t("credentials.photo.providedOn", { date: dateTime(format, row.providedAt, timeZone) })
    : row.requestedAt
      ? t("credentials.photo.requestedOn", { date: dateTime(format, row.requestedAt, timeZone) })
      : null;
  return (
    <RecordSection id="credential-photo" title={t("credentials.photo.heading")}>
      <div className="flex flex-wrap items-start gap-12">
        {thumbnail ? (
          // A 60-second signed link (or a public profile photo); next/image would cache it past its expiry.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnail}
            alt={t("credentials.photo.thumbnailAlt", { name })}
            width={72}
            height={96}
            className="h-96 w-72 rounded-md border border-border object-contain"
          />
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <span className="inline-flex items-center gap-8 text-text-13">
            <span className="text-text-secondary">{t("credentials.photo.stateLabel")}</span>
            <ToneChip tone={PHOTO_TONE[row.state]}>
              {t(`credentials.photo.states.${row.state}`)}
            </ToneChip>
          </span>
          <p className="m-0 text-text-13 text-text-secondary">
            {t(`credentials.photo.stateHelp.${row.state}`)}
            {when ? ` ${when}.` : null}
          </p>
        </div>
      </div>
      {canIssue ? (
        <div className="flex flex-col gap-12">
          {row.state !== "Provided" && row.state !== "Scanning" ? (
            <ActionForm
              action={requestCredentialPhotosAction}
              hidden={{ org: page.ctx.org.slug, id: c.id }}
              submitLabel={t("credentials.photo.request")}
              successKey="credentials.photo.requestDone"
              variant="secondary"
              layout="inline"
            />
          ) : null}
          {link ? (
            <div className="flex w-full max-w-full flex-col gap-4">
              <label
                htmlFor="credential-photo-link"
                className="text-text-12 font-medium text-text-secondary"
              >
                {t("credentials.photo.copyLink")}
              </label>
              <input
                id="credential-photo-link"
                type="text"
                readOnly
                value={link}
                aria-describedby="credential-photo-link-help"
                className="h-control-md w-full rounded-control border border-border-control bg-bg-surface px-8 font-mono text-text-13"
              />
              <span id="credential-photo-link-help" className="text-text-12 text-text-secondary">
                {t("credentials.photo.copyLinkHelp")}
              </span>
            </div>
          ) : null}
          {row.state === "Scanning" ? (
            <p className="m-0 text-text-12 text-text-secondary">
              {t("credentials.photo.removeAfterScan")}
            </p>
          ) : null}
          {row.source && (row.state === "Provided" || row.state === "Refused") ? (
            <ActionForm
              action={removeCredentialPhotoAction}
              hidden={{ org: page.ctx.org.slug, personId: c.holderPersonId }}
              submitLabel={t("credentials.photo.remove")}
              successKey="credentials.photo.removed"
              variant="danger"
            >
              <label className="flex items-center gap-8 text-text-13">
                <input type="checkbox" name="confirm" required className="size-16" />
                {t("credentials.photo.removeConfirm", { name })}
              </label>
            </ActionForm>
          ) : null}
        </div>
      ) : null}
    </RecordSection>
  );
}
