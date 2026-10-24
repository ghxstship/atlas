import { listAuditEvents } from "@xos/data/activity";
import { listCanonExtensionProposals, listDepartments, listDisciplines } from "@xos/data/canon";
import {
  DATA_REQUEST_MOVES,
  getClassificationSummary,
  listDataRequests,
  listExportJobs,
  listLegalHolds,
  listRetentionPolicies,
} from "@xos/data/data-privacy";
import { listOrgExports } from "@xos/data/lifecycle";
import { getDepartmentsInUse, getLocationDefaults } from "@xos/data/org-setup";
import { listJurisdictions } from "@xos/data/places";
import { getOrgUsage } from "@xos/data/usage";
import {
  moveDataRequestAction,
  placeLegalHoldAction,
  releaseLegalHoldAction,
  saveDepartmentsAction,
  saveLocationDefaultsAction,
} from "@/app/[org]/settings/surface-actions";
import type { SettingsPanelProps } from "../contributions/types";
import { SaveBarFields, SaveBarForm, SurfaceButton, SurfaceForm } from "./forms";
import {
  Chip,
  Code,
  formatters,
  qualified,
  LoadFailed,
  P,
  Quiet,
  Rows,
  Section,
  Subsection,
  TextLink,
  type Formatters,
} from "./kit";

/**
 * Org setup and record panels (A86, RRR-131, finding A65-004):
 *   Departments and Disciplines in Use   which canon departments and disciplines the org works in (item 8, 1430)
 *   Locations and Venues Defaults        what a new venue starts with (item 9, 1431)
 *   Usage                                metered usage by billing month, after A61's usage against the plan (item 38)
 *   Data and Privacy                     data requests, legal holds, exports, retention, classification (item 39)
 *   Audit Log                            the latest audit events and the way to the full log (item 40)
 */

// Departments and disciplines in use -----------------------------------------------------------------------

export async function DepartmentsPanel({ ctx }: SettingsPanelProps) {
  const [f, departments, disciplines, inUse, extensions] = await Promise.all([
    formatters(ctx),
    listDepartments(ctx.viewer.db),
    listDisciplines(ctx.viewer.db),
    getDepartmentsInUse(ctx.viewer.db, ctx.org.id),
    listCanonExtensionProposals(ctx.viewer.db, ctx.org.id),
  ]);
  if (!departments.ok || !disciplines.ok || !inUse.ok) return <LoadFailed t={f.t} />;
  const canEdit = ctx.capabilities.has("org.departments.write");
  const approved = extensions.ok
    ? extensions.data.filter((p) => p.state === "Approved" && p.level === "Discipline")
    : [];
  return (
    <>
      <Section
        id="departments-in-use"
        title={f.t(`${P}.departments.title`)}
        description={f.t(`${P}.departments.description`)}
      >
        <p role="status" className="m-0 text-text-13">
          {inUse.data.departments.length === 0
            ? f.t(`${P}.departments.all`)
            : f.t(`${P}.departments.chosen`, {
                departments: inUse.data.departments.length,
                disciplines: inUse.data.disciplines.length,
              })}
        </p>
        <SaveBarForm
          action={saveDepartmentsAction}
          label={f.t(`${P}.departments.title`)}
          hidden={{ org: ctx.org.slug }}
          canEdit={canEdit}
        >
          <SaveBarFields
            formId="departments"
            fields={[
              {
                kind: "checkboxes",
                name: "departments",
                label: f.t(`${P}.departments.departments`),
                help: f.t(`${P}.departments.departmentsHelp`),
                options: departments.data.map((d) => ({
                  value: d.code,
                  label: f.t(`${P}.departments.option`, { name: d.name, code: d.code }),
                })),
                defaultValues: inUse.data.departments,
              },
            ]}
          />
          {departments.data.map((d) => {
            const own = disciplines.data.filter(
              (x) => x.departmentCode === d.code && !x.isExtension,
            );
            if (own.length === 0) return null;
            return (
              <details key={d.code} className="rounded-card border border-border-subtle px-12 py-8">
                <summary className="cursor-pointer text-text-13 font-medium">
                  {f.t(`${P}.departments.disciplinesOf`, { name: d.name, count: own.length })}
                </summary>
                <div className="pt-12">
                  <SaveBarFields
                    formId={`disciplines-${d.code}`}
                    fields={[
                      {
                        kind: "checkboxes",
                        name: "disciplines",
                        label: f.t(`${P}.departments.disciplines`, { name: d.name }),
                        options: own.map((x) => ({
                          value: x.code,
                          label: f.t(`${P}.departments.option`, { name: x.name, code: x.code }),
                        })),
                        defaultValues: inUse.data.disciplines.filter((c) =>
                          own.some((x) => x.code === c),
                        ),
                      },
                    ]}
                  />
                </div>
              </details>
            );
          })}
        </SaveBarForm>
      </Section>
      <Section
        id="departments-extensions"
        title={f.t(`${P}.departments.extensionsTitle`)}
        description={f.t(`${P}.departments.extensionsDescription`)}
      >
        {approved.length === 0 ? (
          <Quiet>{f.t(`${P}.departments.noExtensions`)}</Quiet>
        ) : (
          <Rows
            label={f.t(`${P}.departments.extensionsTitle`)}
            rows={approved.map((p) => ({
              id: p.id,
              title: p.label,
              meta: [
                <Code key="c">{p.proposedCode}</Code>,
                f.t(`${P}.canon.under`, { parent: p.parentCode }),
              ],
            }))}
          />
        )}
        <TextLink href={`/${ctx.org.slug}/settings/canon-extensions`}>
          {f.t(`${P}.departments.toExtensions`)}
        </TextLink>
      </Section>
    </>
  );
}

// Location defaults ------------------------------------------------------------------------------------------

export async function LocationDefaultsPanel({ ctx }: SettingsPanelProps) {
  const [f, defaults, jurisdictions] = await Promise.all([
    formatters(ctx),
    getLocationDefaults(ctx.viewer.db, ctx.org.id),
    listJurisdictions(ctx.viewer.db),
  ]);
  if (!defaults.ok || !jurisdictions.ok) return <LoadFailed t={f.t} />;
  const canEdit = ctx.capabilities.has("org.locations.write");
  const zones = ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")];
  return (
    <Section
      id="location-defaults"
      title={f.t(`${P}.locations.title`)}
      description={f.t(`${P}.locations.description`)}
    >
      <SaveBarForm
        action={saveLocationDefaultsAction}
        label={f.t(`${P}.locations.title`)}
        hidden={{ org: ctx.org.slug }}
        canEdit={canEdit}
      >
        <SaveBarFields
          formId="location-defaults"
          fields={[
            {
              kind: "select",
              name: "jurisdictionId",
              label: f.t(`${P}.locations.jurisdiction`),
              help: f.t(`${P}.locations.jurisdictionHelp`),
              options: [
                { value: "", label: f.t(`${P}.locations.noJurisdiction`) },
                ...jurisdictions.data.map((j) => ({
                  value: j.id,
                  label: j.populated ? j.id : f.t(`${P}.locations.unpopulated`, { id: j.id }),
                })),
              ],
              defaultValue: defaults.data.jurisdictionId ?? "",
            },
            {
              kind: "select",
              name: "timeZone",
              label: f.t(`${P}.locations.timeZone`),
              help: f.t(`${P}.locations.timeZoneHelp`),
              options: [
                { value: "", label: f.t(`${P}.locations.browserZone`) },
                ...zones.map((z) => ({ value: z, label: z.replaceAll("_", " ") })),
              ],
              defaultValue: defaults.data.timeZone ?? "",
            },
          ]}
        />
      </SaveBarForm>
      <TextLink href={`/${ctx.org.slug}/places/venues`}>{f.t(`${P}.locations.toVenues`)}</TextLink>
    </Section>
  );
}

// Metered usage ---------------------------------------------------------------------------------------------

/** Settings, Usage after A61's usage against the plan: every meter by billing month (1433). */
export async function MeteredUsagePanel({ ctx }: SettingsPanelProps) {
  const [f, usage] = await Promise.all([
    formatters(ctx),
    getOrgUsage(ctx.viewer.db, ctx.org.id, 3),
  ]);
  const month = new Intl.DateTimeFormat(f.locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return (
    <Section
      id="usage-meters"
      title={f.t(`${P}.usage.metersTitle`)}
      description={f.t(`${P}.usage.metersDescription`)}
    >
      {!usage.ok ? (
        <Quiet>{f.t(`${P}.usage.metersHidden`)}</Quiet>
      ) : (
        usage.data.map((period) => (
          <Subsection
            key={`${period.periodStart}-${period.closed}`}
            title={f.t(period.closed ? `${P}.usage.closedMonth` : `${P}.usage.openMonth`, {
              month: month.format(new Date(`${period.periodStart}T00:00:00Z`)),
            })}
          >
            <Rows
              label={month.format(new Date(`${period.periodStart}T00:00:00Z`))}
              rows={period.lines.map((line) => ({
                id: line.meter,
                title: f.t(`${P}.usage.meters.${line.meter}`),
                meta: [
                  f.t(`${P}.usage.units.${line.unit}`, {
                    count: line.quantity,
                    formatted: f.number(line.quantity),
                  }),
                ],
              }))}
            />
          </Subsection>
        ))
      )}
    </Section>
  );
}

// Data and privacy ------------------------------------------------------------------------------------------

function stateLabel(f: Formatters, state: string): string {
  return f.t(`${P}.privacy.states.${state.replaceAll(" ", "")}`);
}

export async function DataRequestsPanel({ ctx }: SettingsPanelProps) {
  const [f, requests] = await Promise.all([
    formatters(ctx),
    listDataRequests(ctx.viewer.db, ctx.org.id),
  ]);
  if (!requests.ok) return <LoadFailed t={f.t} />;
  const canEdit = ctx.capabilities.has("data.request.manage");
  return (
    <Section
      id="data-requests"
      title={f.t(`${P}.privacy.requestsTitle`)}
      description={f.t(`${P}.privacy.requestsDescription`)}
    >
      {!canEdit ? <Quiet>{f.t(`${P}.privacy.requestsHidden`)}</Quiet> : null}
      {canEdit && requests.data.length === 0 ? (
        <Quiet>{f.t(`${P}.privacy.noRequests`)}</Quiet>
      ) : null}
      {requests.data.length > 0 ? (
        <Rows
          label={f.t(`${P}.privacy.requestsTitle`)}
          rows={requests.data.map((r) => ({
            id: r.id,
            title: (
              <>
                {f.t(`${P}.privacy.types.${r.type.replaceAll(" ", "")}`)}
                <Chip
                  tone={
                    DATA_REQUEST_MOVES[r.state].length === 0
                      ? "neutral"
                      : r.overdue
                        ? "danger"
                        : "warning"
                  }
                >
                  {stateLabel(f, r.state)}
                </Chip>
                {r.overdue ? <Chip tone="danger">{f.t(`${P}.privacy.overdue`)}</Chip> : null}
              </>
            ),
            meta: [
              r.subjectEmail,
              f.t(`${P}.privacy.received`, { date: f.day(r.receivedAt) }),
              r.dueAt && DATA_REQUEST_MOVES[r.state].length > 0
                ? f.t(`${P}.privacy.due`, { date: f.day(r.dueAt) })
                : null,
            ],
            actions: canEdit
              ? DATA_REQUEST_MOVES[r.state].map((next) => (
                  <SurfaceButton
                    key={next}
                    action={moveDataRequestAction}
                    hidden={{ org: ctx.org.slug, id: r.id, expected: r.state, next }}
                    label={f.t(`${P}.privacy.moveTo`, { state: stateLabel(f, next) })}
                    confirm={{
                      title: f.t(`${P}.privacy.moveTitle`, { state: stateLabel(f, next) }),
                      body: f.t(`${P}.privacy.moveBody`),
                      confirmLabel: f.t(`${P}.privacy.moveConfirm`),
                      cancelLabel: f.t(`${P}.cancel`),
                      reason: { name: "reason", label: f.t(`${P}.fields.reason`) },
                    }}
                  />
                ))
              : undefined,
            children: r.details ? (
              <p className="m-0 text-text-12 text-text-secondary">{r.details}</p>
            ) : undefined,
          }))}
        />
      ) : null}
    </Section>
  );
}

export async function LegalHoldsPanel({ ctx }: SettingsPanelProps) {
  const [f, holds, policies] = await Promise.all([
    formatters(ctx),
    listLegalHolds(ctx.viewer.db, ctx.org.id),
    listRetentionPolicies(ctx.viewer.db),
  ]);
  const canEdit = ctx.capabilities.has("data.legal_hold.manage");
  if (!holds.ok || !policies.ok) return <LoadFailed t={f.t} />;
  return (
    <Section
      id="legal-holds"
      title={f.t(`${P}.privacy.holdsTitle`)}
      description={f.t(`${P}.privacy.holdsDescription`)}
    >
      {!canEdit ? <Quiet>{f.t(`${P}.privacy.holdsHidden`)}</Quiet> : null}
      {canEdit && holds.data.length === 0 ? <Quiet>{f.t(`${P}.privacy.noHolds`)}</Quiet> : null}
      {holds.data.length > 0 ? (
        <Rows
          label={f.t(`${P}.privacy.holdsTitle`)}
          rows={holds.data.map((h) => ({
            id: h.id,
            title: (
              <>
                {h.matter}
                {h.releasedAt ? (
                  <Chip>{f.t(`${P}.privacy.released`)}</Chip>
                ) : (
                  <Chip tone="warning">{f.t(`${P}.privacy.inForce`)}</Chip>
                )}
              </>
            ),
            meta: [
              h.tableName ? <Code key="t">{h.tableName}</Code> : f.t(`${P}.privacy.allTables`),
              f.t(`${P}.privacy.placed`, { date: f.day(h.placedAt) }),
              h.releasedAt ? f.t(`${P}.privacy.releasedOn`, { date: f.day(h.releasedAt) }) : null,
            ],
            actions:
              canEdit && !h.releasedAt ? (
                <SurfaceButton
                  action={releaseLegalHoldAction}
                  hidden={{ org: ctx.org.slug, id: h.id }}
                  label={f.t(`${P}.privacy.release`)}
                  confirm={{
                    title: f.t(`${P}.privacy.releaseTitle`, { matter: h.matter }),
                    body: f.t(`${P}.privacy.releaseBody`),
                    confirmLabel: f.t(`${P}.privacy.release`),
                    cancelLabel: f.t(`${P}.cancel`),
                  }}
                />
              ) : undefined,
          }))}
        />
      ) : null}
      {canEdit ? (
        <Subsection title={f.t(`${P}.privacy.placeHold`)}>
          <SurfaceForm
            id="legal-hold-create"
            action={placeLegalHoldAction}
            label={f.t(`${P}.privacy.placeHold`)}
            hidden={{ org: ctx.org.slug }}
            submitLabel={f.t(`${P}.privacy.placeSubmit`)}
            doneLabel={f.t(`${P}.privacy.placed`, { date: f.day(new Date().toISOString()) })}
            fields={[
              {
                kind: "text",
                name: "matter",
                label: f.t(`${P}.privacy.matter`),
                help: f.t(`${P}.privacy.matterHelp`),
                required: true,
                maxLength: 300,
              },
              {
                kind: "select",
                name: "table",
                label: f.t(`${P}.privacy.table`),
                options: [
                  { value: "", label: f.t(`${P}.privacy.allTables`) },
                  ...policies.data.map((p) => ({ value: p.tableName, label: p.tableName })),
                ],
                defaultValue: "",
              },
            ]}
          />
        </Subsection>
      ) : null}
    </Section>
  );
}

export async function ExportsAndRetentionPanel({ ctx }: SettingsPanelProps) {
  const [f, jobs, archives, policies, classes] = await Promise.all([
    formatters(ctx),
    listExportJobs(ctx.viewer.db, ctx.org.id, 10),
    listOrgExports(ctx.viewer.db, ctx.org.id),
    listRetentionPolicies(ctx.viewer.db),
    getClassificationSummary(ctx.viewer.db),
  ]);
  if (!jobs.ok || !policies.ok || !classes.ok) return <LoadFailed t={f.t} />;
  const keyTables = [
    "app.audit_events",
    "app.chat_messages",
    "app.notifications",
    "app.usage_events",
    "app.file_access_log",
  ];
  const shown = policies.data.filter((p) => keyTables.includes(p.tableName));
  return (
    <>
      <Section
        id="data-exports"
        title={f.t(`${P}.privacy.exportsTitle`)}
        description={f.t(`${P}.privacy.exportsDescription`)}
      >
        {jobs.data.length === 0 && !(archives.ok && archives.data.length > 0) ? (
          <Quiet>{f.t(`${P}.privacy.noExports`)}</Quiet>
        ) : (
          <Rows
            label={f.t(`${P}.privacy.exportsTitle`)}
            rows={[
              ...(archives.ok ? archives.data.slice(0, 3) : []).map((a) => ({
                id: a.id,
                title: f.t(`${P}.privacy.archive`),
                meta: [
                  f.when(a.createdAt),
                  f.t(`${P}.privacy.archiveSize`, {
                    tables: a.tableCount,
                    rows: f.number(a.rowCount),
                  }),
                ],
              })),
              ...jobs.data.map((j) => ({
                id: j.id,
                title: (
                  <>
                    {j.sourceLabel}
                    <Chip>{f.t(`${P}.privacy.classes.${j.classification}`)}</Chip>
                  </>
                ),
                meta: [
                  j.format,
                  f.when(j.createdAt),
                  j.rowCount !== null ? f.number(j.rowCount) : null,
                ],
              })),
            ]}
          />
        )}
        <TextLink href={`/${ctx.org.slug}/settings/danger-zone`}>
          {f.t(`${P}.privacy.toArchive`)}
        </TextLink>
      </Section>
      <Section
        id="data-classification"
        title={f.t(`${P}.privacy.classificationTitle`)}
        description={f.t(`${P}.privacy.classificationDescription`)}
      >
        <p role="status" className="m-0 text-text-13">
          {f.t(`${P}.privacy.classCounts`, {
            public: classes.data.counts.Public,
            internal: classes.data.counts.Internal,
            confidential: classes.data.counts.Confidential,
            restricted: classes.data.counts.Restricted,
          })}
        </p>
        <Rows
          label={f.t(`${P}.privacy.restrictedColumns`)}
          rows={classes.data.restricted.slice(0, 12).map((c) => ({
            id: `${c.table}.${c.column}`,
            title: <Code>{qualified(c.table, c.column)}</Code>,
            meta: [c.capability ? f.t(`${P}.privacy.readBy`, { capability: c.capability }) : null],
          }))}
        />
      </Section>
      <Section
        id="data-retention"
        title={f.t(`${P}.privacy.retentionTitle`)}
        description={f.t(`${P}.privacy.retentionDescription`)}
      >
        <Rows
          label={f.t(`${P}.privacy.retentionTitle`)}
          rows={shown.map((p) => ({
            id: p.tableName,
            title: <Code>{p.tableName}</Code>,
            meta: [f.t(`${P}.privacy.keptFor`, { period: p.retention }), p.rationale],
          }))}
        />
        <Quiet>{f.t(`${P}.privacy.retentionMore`, { count: policies.data.length })}</Quiet>
        <TextLink href={`/${ctx.org.slug}/settings/communication`}>
          {f.t(`${P}.privacy.toMessageRetention`)}
        </TextLink>
      </Section>
    </>
  );
}

// Audit log -------------------------------------------------------------------------------------------------

export async function AuditLogPanel({ ctx }: SettingsPanelProps) {
  const [f, events] = await Promise.all([
    formatters(ctx),
    listAuditEvents(ctx.viewer.db, { orgId: ctx.org.id, limit: 10 }),
  ]);
  const canRead = ctx.capabilities.has("audit.log.read");
  return (
    <Section
      id="audit-latest"
      title={f.t(`${P}.audit.title`)}
      description={f.t(`${P}.audit.description`)}
    >
      {!canRead || !events.ok ? (
        <Quiet>{f.t(`${P}.audit.hidden`)}</Quiet>
      ) : events.data.entries.length === 0 ? (
        <Quiet>{f.t(`${P}.audit.none`)}</Quiet>
      ) : (
        <Rows
          label={f.t(`${P}.audit.title`)}
          rows={events.data.entries.map((e) => ({
            id: e.id,
            title: <Code>{e.action}</Code>,
            meta: [
              e.actor ?? f.t(`${P}.audit.actors.${e.actorKind}`),
              f.when(e.at),
              e.redacted ? f.t(`${P}.audit.redacted`) : null,
            ],
          }))}
        />
      )}
      <Quiet>{f.t(`${P}.audit.retention`)}</Quiet>
      <TextLink href={`/${ctx.org.slug}/activity/audit-log`}>{f.t(`${P}.audit.open`)}</TextLink>
    </Section>
  );
}
