import {
  getIncident,
  INCIDENT_MOVES,
  INCIDENT_STATES,
  listCrisisAlerts,
  listDispatchAssignments,
  listEmergencyCodes,
  listEmergencyProtocols,
  listIncidentHistory,
  listIncidentMedia,
  listIncidentParties,
  listIncidents,
  listIncidentSeverities,
  listMedicalEncounters,
  listProjectAuthorities,
  listRadioChannels,
  type CrisisAlert,
  type EmergencyCode,
  type Incident,
  type IncidentSeverity,
  type IncidentState,
  type RadioChannel,
} from "@xos/data/incidents";
import { listProjectZones, type OperationsProject, type Zone } from "@xos/data/credentials";
import { listMembers } from "@xos/data";
import type { Route } from "next";
import { getFormatter } from "next-intl/server";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/operations/action-form";
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
import { SelectField, TextAreaField, TextField } from "@/components/operations/fields";
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
  type ListItem,
} from "@/components/operations/kit";
import { LiveRefresh } from "@/components/operations/peek";
import { RecordCollab } from "@/components/operations/record-collab";
import { CustomFieldInputs } from "@/components/custom-fields/inputs";
import { CustomFieldList } from "@/components/custom-fields/list";
import { CustomFieldsPanel } from "@/components/custom-fields/custom-fields-panel";
import { customFieldColumns } from "@/components/custom-fields/columns";
import { customFieldList } from "@/lib/custom-fields/server";
import { customConditionsOf } from "@/lib/views/conditions";
import { EmergencyCodeCard, TemplateSplitView } from "@/components/operations/ui";
import { MapView } from "@/components/platform/client/map-view";
import { ButtonLink, EmptyStateLink } from "@/components/ui";
import {
  addEncounterAction,
  addMediaAction,
  addPartyAction,
  archiveChannelAction,
  arrivedAction,
  closeIncidentAction,
  createChannelAction,
  dispatchAction,
  endAlertAction,
  importPlanAction,
  issueAlertAction,
  removeMediaAction,
  removePartyAction,
  reportIncidentAction,
  transitionIncidentAction,
  updateChannelAction,
  updateEmergencyCodeAction,
  updateIncidentAction,
  withdrawAction,
} from "@/lib/incidents/actions";
import { can, chooseView, type ModulePage } from "@/lib/operations/context";
import { rememberView } from "@/lib/shell/recents";
import { instantToLocal } from "@/lib/operations/time";
import { IncidentOshaPanel } from "@/components/compliance/osha-panels";
import { DocumentActions } from "@/components/documents/document-actions";

/**
 * Safety incidents (Section 4.2: incidents with dispatch, emergency codes, radio): the incident
 * CAD log, the dispatch board, the global emergency codes with crisis alerts, and the radio plan.
 * Closing an incident always records sign-off (invariant 22); medical notes stay masked unless the
 * viewer holds the medical capability, and are never exported or sent to a model (Section 14.3).
 */

const STATE_TONE: Record<IncidentState, "accent" | "warning" | "success" | "neutral"> = {
  Reported: "accent",
  Dispatched: "warning",
  Contained: "success",
  Closed: "neutral",
};

function severityTone(severity: IncidentSeverity | undefined): "danger" | "warning" | "neutral" {
  if (!severity) return "neutral";
  if (severity.isCritical) return "danger";
  return severity.sortOrder <= 2 ? "warning" : "neutral";
}

function StateChip({ page, state }: { page: ModulePage; state: IncidentState }) {
  return <ToneChip tone={STATE_TONE[state]}>{page.t(`incidents.states.${state}`)}</ToneChip>;
}

function SeverityChip({ severities, id }: { severities: readonly IncidentSeverity[]; id: string }) {
  const severity = severities.find((s) => s.id === id);
  return <ToneChip tone={severityTone(severity)}>{severity?.label ?? id}</ToneChip>;
}

function projectOf(page: ModulePage, id: string): OperationsProject | undefined {
  return page.projects.find((p) => p.id === id);
}

/** Lays incident locations into the map drawing, keeping their relative positions. */
function mapPins(incidents: readonly Incident[], width: number, height: number) {
  const located = incidents.filter((i) => i.latitude !== null && i.longitude !== null);
  if (located.length === 0) return [];
  const lats = located.map((i) => i.latitude as number);
  const lngs = located.map((i) => i.longitude as number);
  const [minLat, maxLat, minLng, maxLng] = [
    Math.min(...lats),
    Math.max(...lats),
    Math.min(...lngs),
    Math.max(...lngs),
  ];
  const pad = 40;
  const spanLat = maxLat - minLat || 1;
  const spanLng = maxLng - minLng || 1;
  return located.map((i) => ({
    incident: i,
    x: pad + (((i.longitude as number) - minLng) / spanLng) * (width - 2 * pad),
    y: pad + ((maxLat - (i.latitude as number)) / spanLat) * (height - 2 * pad),
  }));
}

// Incidents ----------------------------------------------------------------------------------------

export async function IncidentsSection({ page }: { page: ModulePage }) {
  const t = page.t;
  const section = "incidents";
  const format = await getFormatter();
  const stateFilter = param(page.search, "state") as IncidentState | undefined;
  const severityFilter = param(page.search, "severity");
  const [incidentsResult, severitiesResult, custom] = await Promise.all([
    listIncidents(page.ctx.viewer.db, {
      orgId: page.ctx.org.id,
      ...(page.project ? { projectId: page.project.id } : {}),
      ...(stateFilter && INCIDENT_STATES.includes(stateFilter) ? { states: [stateFilter] } : {}),
    }),
    listIncidentSeverities(page.ctx.viewer.db),
    customFieldList(page.ctx, "app.incidents", page.search),
  ]);
  const severities = unwrap(severitiesResult, "severities");
  const incidents = unwrap(incidentsResult, "incidents").filter(
    (i) => (!severityFilter || i.severityId === severityFilter) && custom.keep(i.id),
  );
  const customView = await custom.view(incidents.map((i) => i.id));
  const customColumns = customFieldColumns(customView);
  const located = incidents.some((i) => i.latitude !== null);
  const declared = chooseView("safety.incidents", param(page.search, "view"));
  // The map view appears only when the data has a location (Section 11.15).
  const views = declared.views.filter((v) => v !== "map" || located);
  const view = views.includes(declared.view) ? declared.view : "list";
  const peekId = param(page.search, "peek");
  const creating = param(page.search, "create") === "1";
  const canReport = can(page, "safety.incident.write");
  const title = t("nav.atlas.pages.safety.incidents");
  const peekHref = (i: Incident) =>
    sectionHref(page, { peek: i.id, full: undefined, create: undefined, section });
  const zoneLabel = (i: Incident) =>
    i.zoneCode ? joined(i.zoneCode, i.zoneName) : t("incidents.noZone");
  const when = (i: Incident) =>
    dateTime(format, i.occurredAt, projectOf(page, i.projectId)?.timeZone);

  const columns: Column<Incident>[] = [
    {
      key: "key",
      label: t("incidents.key"),
      primary: true,
      render: (i) => <span className="font-mono">{i.key}</span>,
    },
    { key: "title", label: t("incidents.title"), primary: true, render: (i) => i.title },
    {
      key: "severity",
      label: t("incidents.severity"),
      render: (i) => <SeverityChip severities={severities} id={i.severityId} />,
    },
    { key: "zone", label: t("incidents.zone"), render: zoneLabel },
    { key: "occurred", label: t("incidents.occurredAt"), render: when },
    {
      key: "state",
      label: t("incidents.state"),
      primary: true,
      render: (i) => <StateChip page={page} state={i.state} />,
    },
    ...customColumns.columns.map((c) => ({
      key: c.key,
      label: c.label,
      render: (i: Incident) => customColumns.cells(i.id)[c.key] ?? "",
    })),
  ];
  const item = (i: Incident): ListItem => ({
    key: i.id,
    href: peekHref(i),
    title: joined(i.key, i.title),
    meta: joined(severities.find((s) => s.id === i.severityId)?.label, zoneLabel(i), when(i)),
    trailing: <StateChip page={page} state={i.state} />,
  });

  let body: ReactNode;
  if (incidents.length === 0) {
    body = (
      <EmptyStateLink
        icon="Siren"
        sentence={t(
          stateFilter || severityFilter || customConditionsOf(page.search).length > 0
            ? "incidents.emptyFiltered"
            : "incidents.empty",
        )}
        actionLabel={t("incidents.report")}
        href={sectionHref(page, { create: "1", section })}
      />
    );
  } else if (view === "table") {
    body = (
      <OpsTable
        caption={title}
        columns={columns}
        rows={incidents}
        rowKey={(i) => i.id}
        rowHref={peekHref}
        selected={peekId}
      />
    );
  } else if (view === "board") {
    body = (
      <OpsBoard
        label={title}
        columns={INCIDENT_STATES.map((s) => ({
          key: s,
          label: t(`incidents.states.${s}`),
          empty: t("incidents.boardEmpty"),
          items: incidents.filter((i) => i.state === s).map(item),
        }))}
      />
    );
  } else if (view === "map") {
    body = <IncidentMap page={page} incidents={incidents} peekHref={peekHref} />;
  } else {
    body = <OpsList label={title} items={incidents.map(item)} />;
  }

  return (
    <CustomFieldList value={customView}>
      <Header
        page={page}
        section={section}
        title={title}
        count={incidents.length}
        views={views}
        view={view}

        action={
          canReport ? (
            <ButtonLink
              href={sectionHref(page, { create: "1", peek: undefined, section })}
              variant="primary"
            >
              {t("incidents.report")}
            </ButtonLink>
          ) : undefined
        }
      />
      <ProjectFilter
        page={page}
        section={section}
        extra={[
          {
            name: "state",
            label: t("incidents.state"),
            value: stateFilter ?? "",
            options: [
              { value: "", label: t("incidents.anyState") },
              ...INCIDENT_STATES.map((s) => ({ value: s, label: t(`incidents.states.${s}`) })),
            ],
          },
          {
            name: "severity",
            label: t("incidents.severity"),
            value: severityFilter ?? "",
            options: [
              { value: "", label: t("incidents.anySeverity") },
              ...severities.map((s) => ({ value: s.id, label: s.label })),
            ],
          },
        ]}
      />
      {creating && canReport ? (
        page.project ? (
          <ReportForm page={page} project={page.project} severities={severities} />
        ) : (
          chooseProjectNotice(page, section, {
            choose: t("incidents.chooseProject"),
            none: t("incidents.noProjects"),
          })
        )
      ) : null}
      {body}
      {peekId ? (
        <IncidentRecord page={page} id={peekId} section={section} severities={severities} />
      ) : null}
    </CustomFieldList>
  );
}

function IncidentMap({
  page,
  incidents,
  peekHref,
}: {
  page: ModulePage;
  incidents: readonly Incident[];
  peekHref: (i: Incident) => Route;
}) {
  const t = page.t;
  const width = 800;
  const height = 400;
  const pins = mapPins(incidents, width, height);
  return (
    <div className="flex flex-col gap-12">
      <MapView
        label={t("incidents.mapLabel")}
        width={width}
        height={height}
        zones={[]}
        pins={pins.map((p) => ({
          x: p.x,
          y: p.y,
          label: joined(p.incident.key, p.incident.title),
          tone:
            p.incident.state === "Reported"
              ? "danger"
              : p.incident.state === "Closed"
                ? "accent"
                : "warning",
        }))}
      />
      <OpsList
        label={t("incidents.mapAlternative")}
        items={pins.map((p) => ({
          key: p.incident.id,
          href: peekHref(p.incident),
          title: joined(p.incident.key, p.incident.title),
          meta: joined(String(p.incident.latitude), String(p.incident.longitude)),
          trailing: <StateChip page={page} state={p.incident.state} />,
        }))}
      />
    </div>
  );
}

async function ReportForm({
  page,
  project,
  severities,
}: {
  page: ModulePage;
  project: OperationsProject;
  severities: readonly IncidentSeverity[];
}) {
  const t = page.t;
  const zones = unwrap(
    await listProjectZones(page.ctx.viewer.db, page.ctx.org.id, project.venueId),
    "zones",
  );
  return (
    <RecordSection id="report-incident" title={t("incidents.report")}>
      <ActionForm
        action={reportIncidentAction}
        hidden={{ org: page.ctx.org.slug, projectId: project.id, timeZone: project.timeZone }}
        submitLabel={t("incidents.file")}
        successKey="incidents.filed"
        layout="inline"
        resetOnSuccess
      >
        <TextField
          id="incident-title"
          name="title"
          label={t("incidents.title")}
          required
          maxLength={200}
          wide
        />
        <SelectField
          id="incident-severity"
          name="severityId"
          label={t("incidents.severity")}
          options={severities.map((s) => ({ value: s.id, label: s.label }))}
          required
        />
        <ZoneSelect page={page} id="incident-zone" zones={zones} />
        <TextField
          id="incident-occurred"
          name="occurredAt"
          type="datetime-local"
          required
          label={t("incidents.occurredAt")}
          defaultValue={instantToLocal(new Date().toISOString(), project.timeZone)}
          help={t("incidents.timeZoneHelp", { zone: project.timeZone })}
        />
        <CustomFieldInputs table="app.incidents" />
      </ActionForm>
    </RecordSection>
  );
}

function ZoneSelect({
  page,
  id,
  zones,
  defaultValue,
}: {
  page: ModulePage;
  id: string;
  zones: readonly Zone[];
  defaultValue?: string | null;
}) {
  return (
    <SelectField
      id={id}
      name="zoneId"
      label={page.t("incidents.zone")}
      options={[
        { value: "", label: page.t("incidents.noZone") },
        ...zones.map((z) => ({ value: z.id, label: joined(z.code, z.name, z.venueName) })),
      ]}
      defaultValue={defaultValue ?? ""}
    />
  );
}

async function IncidentRecord({
  page,
  id,
  section,
  severities,
}: {
  page: ModulePage;
  id: string;
  section: string;
  severities: readonly IncidentSeverity[];
}) {
  const t = page.t;
  const db = page.ctx.viewer.db;
  const format = await getFormatter();
  const closeHref = sectionHref(page, { peek: undefined, full: undefined, section });
  const result = await getIncident(db, id);
  if (!result.ok) return <RecordMissing page={page} closeHref={closeHref} />;
  const incident = result.data;
  const project = projectOf(page, incident.projectId);
  const timeZone = project?.timeZone ?? "UTC";
  const [history, parties, media, dispatch, encounters, members, zones] = await Promise.all([
    listIncidentHistory(db, incident.id),
    listIncidentParties(db, incident.id),
    listIncidentMedia(db, incident.id),
    listDispatchAssignments(db, [incident.id]),
    listMedicalEncounters(db, incident.id),
    listMembers(db, page.ctx.org.id),
    listProjectZones(db, page.ctx.org.id, project?.venueId ?? null),
    // The command menu's recent items (Section 11.7), last so no read above changes position.
    rememberView(page.ctx, "incidents", incident.id),
  ]);
  const canWrite = can(page, "safety.incident.write") && incident.state !== "Closed";
  const canDispatch = can(page, "safety.incident.dispatch") && incident.state !== "Closed";
  const canClose = can(page, "safety.incident.close") && incident.state === "Contained";
  const canMedical = canWrite && can(page, "data.restricted.read.medical");
  const moves = INCIDENT_MOVES[incident.state].filter((m) => m !== "Closed");
  const hidden = { org: page.ctx.org.slug, id: incident.id };
  const memberList = members.ok ? members.data : [];

  return (
    <RecordChrome
      page={page}
      full={param(page.search, "full") === "1"}
      title={incident.title}
      recordKey={incident.key}
      kindLabel={t("incidents.kind")}
      closeHref={closeHref}
      fullHref={sectionHref(page, { peek: incident.id, full: "1", section })}
      properties={
        <Properties
          label={t("credentials.common.properties")}
          rows={[
            {
              label: t("incidents.state"),
              value: <StateChip page={page} state={incident.state} />,
            },
            {
              label: t("incidents.severity"),
              value: <SeverityChip severities={severities} id={incident.severityId} />,
            },
            {
              label: t("credentials.common.project"),
              value: project ? joined(project.key, project.name) : incident.projectKey,
            },
            {
              label: t("incidents.zone"),
              value: incident.zoneCode
                ? joined(incident.zoneCode, incident.zoneName)
                : t("incidents.noZone"),
            },
            {
              label: t("incidents.occurredAt"),
              value: dateTime(format, incident.occurredAt, timeZone),
            },
            {
              label: t("incidents.reportedBy"),
              value: incident.reportedByName ?? t("credentials.common.unnamed"),
            },
            ...(incident.latitude !== null
              ? [
                  {
                    label: t("incidents.location"),
                    value: joined(String(incident.latitude), String(incident.longitude)),
                  },
                ]
              : []),
            ...(incident.closedSignedOffByName
              ? [{ label: t("incidents.signedOffBy"), value: incident.closedSignedOffByName }]
              : []),
          ]}
        />
      }
    >
      <DocumentActions org={page.ctx.org.slug} kind="incident-report" id={incident.id} />
      <IncidentOshaPanel ctx={page.ctx} incidentId={incident.id} members={memberList} />
      {moves.length > 0 && (canDispatch || canWrite) ? (
        <RecordSection id="incident-move" title={t("incidents.moveHeading")}>
          {moves
            .filter((next) => (next === "Dispatched" ? canDispatch : canWrite))
            .map((next) => (
              <ActionForm
                key={`${incident.state}-${next}`}
                action={transitionIncidentAction}
                hidden={{ ...hidden, expected: incident.state, next }}
                submitLabel={t(`incidents.moveTo.${next}`)}
                successKey="incidents.moved"
                layout="inline"
                variant="secondary"
              >
                <TextField
                  id={`reason-${next}`}
                  name="reason"
                  label={t("incidents.reason")}
                  required
                  maxLength={500}
                />
              </ActionForm>
            ))}
        </RecordSection>
      ) : null}
      {canClose ? (
        <RecordSection id="incident-close" title={t("incidents.closeHeading")}>
          <p className="m-0 text-text-13 text-text-secondary">{t("incidents.closeHelp")}</p>
          <ActionForm
            action={closeIncidentAction}
            hidden={hidden}
            submitLabel={t("incidents.close")}
            successKey="incidents.closed"
            variant="danger"
          >
            <TextAreaField
              id="signoff-note"
              name="note"
              label={t("incidents.signoffNote")}
              required
              maxLength={500}
            />
          </ActionForm>
        </RecordSection>
      ) : null}
      {canWrite ? (
        <RecordSection id="incident-edit" title={t("credentials.common.edit")}>
          <ActionForm
            action={updateIncidentAction}
            hidden={{ ...hidden, timeZone }}
            submitLabel={t("credentials.common.save")}
            successKey="credentials.common.saved"
            layout="inline"
          >
            <TextField
              id="edit-title"
              name="title"
              label={t("incidents.title")}
              defaultValue={incident.title}
              required
              maxLength={200}
              wide
            />
            <SelectField
              id="edit-severity"
              name="severityId"
              label={t("incidents.severity")}
              options={severities.map((s) => ({ value: s.id, label: s.label }))}
              defaultValue={incident.severityId}
            />
            <ZoneSelect
              page={page}
              id="edit-zone"
              zones={zones.ok ? zones.data : []}
              defaultValue={incident.zoneId}
            />
            <TextField
              id="edit-occurred"
              name="occurredAt"
              type="datetime-local"
              required
              label={t("incidents.occurredAt")}
              defaultValue={instantToLocal(incident.occurredAt, timeZone)}
            />
          </ActionForm>
        </RecordSection>
      ) : null}
      <RecordSection id="incident-dispatch" title={t("incidents.respondersHeading")}>
        {dispatch.ok && dispatch.data.length > 0 ? (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {dispatch.data.map((d) => (
              <li
                key={d.id}
                className="flex flex-wrap items-center justify-between gap-8 py-8 text-text-13"
              >
                <span className="flex flex-col gap-2">
                  <span className="font-medium">
                    {d.responderName ?? t("credentials.common.unnamed")}
                  </span>
                  <span className="text-text-12 text-text-secondary">
                    {d.arrivedAt
                      ? t("incidents.arrivedAt", { time: dateTime(format, d.arrivedAt, timeZone) })
                      : t("incidents.dispatchedAt", {
                          time: dateTime(format, d.dispatchedAt, timeZone),
                        })}
                  </span>
                </span>
                {canDispatch ? (
                  <span className="flex items-center gap-8">
                    {d.arrivedAt ? null : (
                      <ActionForm
                        action={arrivedAction}
                        hidden={{ org: page.ctx.org.slug, id: d.id }}
                        submitLabel={t("incidents.markArrived")}
                        variant="secondary"
                        layout="inline"
                      />
                    )}
                    <ActionForm
                      action={withdrawAction}
                      hidden={{ org: page.ctx.org.slug, id: d.id }}
                      submitLabel={t("incidents.withdraw")}
                      variant="ghost"
                      layout="inline"
                    />
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-text-13 text-text-secondary">{t("incidents.noResponders")}</p>
        )}
        {canDispatch ? (
          <ActionForm
            action={dispatchAction}
            hidden={{ org: page.ctx.org.slug, incidentId: incident.id }}
            submitLabel={t("incidents.dispatch")}
            successKey="incidents.dispatched"
            layout="inline"
          >
            <SelectField
              id="dispatch-member"
              name="membershipId"
              label={t("incidents.responder")}
              options={memberList.map((m) => ({
                value: m.membershipId,
                label: m.fullName ?? t("credentials.common.unnamed"),
              }))}
              required
            />
          </ActionForm>
        ) : null}
      </RecordSection>
      <RecordSection id="incident-parties" title={t("incidents.partiesHeading")}>
        {parties.ok && parties.data.length > 0 ? (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {parties.data.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-8 py-8 text-text-13"
              >
                <span>{joined(p.personName, p.description)}</span>
                {canWrite ? (
                  <ActionForm
                    action={removePartyAction}
                    hidden={{ org: page.ctx.org.slug, id: p.id }}
                    submitLabel={t("incidents.remove")}
                    variant="ghost"
                    layout="inline"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-text-13 text-text-secondary">{t("incidents.noParties")}</p>
        )}
        {canWrite ? (
          <ActionForm
            action={addPartyAction}
            hidden={{ org: page.ctx.org.slug, incidentId: incident.id }}
            submitLabel={t("incidents.addParty")}
            successKey="incidents.partyAdded"
            layout="inline"
            resetOnSuccess
          >
            <SelectField
              id="party-person"
              name="personId"
              label={t("incidents.person")}
              options={[
                { value: "", label: t("incidents.unknownPerson") },
                ...memberList.map((m) => ({
                  value: m.personId,
                  label: m.fullName ?? t("credentials.common.unnamed"),
                })),
              ]}
            />
            <TextField
              id="party-description"
              name="description"
              label={t("incidents.partyDescription")}
              help={t("incidents.partyDescriptionHelp")}
              required
              maxLength={500}
            />
          </ActionForm>
        ) : null}
      </RecordSection>
      <RecordSection id="incident-media" title={t("incidents.mediaHeading")}>
        {media.ok && media.data.length > 0 ? (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {media.data.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-center justify-between gap-8 py-8 text-text-13"
              >
                <span className="font-mono break-all">{m.mediaUri}</span>
                {canWrite ? (
                  <ActionForm
                    action={removeMediaAction}
                    hidden={{ org: page.ctx.org.slug, id: m.id }}
                    submitLabel={t("incidents.remove")}
                    variant="ghost"
                    layout="inline"
                  />
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-text-13 text-text-secondary">{t("incidents.noMedia")}</p>
        )}
        {canWrite ? (
          <ActionForm
            action={addMediaAction}
            hidden={{ org: page.ctx.org.slug, incidentId: incident.id }}
            submitLabel={t("incidents.addMedia")}
            successKey="incidents.mediaAdded"
            layout="inline"
            resetOnSuccess
          >
            <TextField
              id="media-uri"
              name="mediaUri"
              label={t("incidents.mediaUri")}
              help={t("incidents.mediaUriHelp")}
              required
              maxLength={1000}
            />
          </ActionForm>
        ) : null}
      </RecordSection>
      <RecordSection id="incident-medical" title={t("incidents.medicalHeading")}>
        <p className="m-0 text-text-12 text-text-secondary">{t("incidents.medicalNotice")}</p>
        {encounters.ok && encounters.data.length > 0 ? (
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {encounters.data.map((e) => (
              <li key={e.id} className="flex flex-col gap-2 py-8 text-text-13">
                <span className="font-medium">{joined(e.patientDescription, e.disposition)}</span>
                <span className="text-text-12 text-text-secondary">
                  {e.isMasked
                    ? t("incidents.notesMasked")
                    : (e.treatmentNotes ?? t("incidents.noNotes"))}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="m-0 text-text-13 text-text-secondary">{t("incidents.noEncounters")}</p>
        )}
        {canMedical && project ? (
          <ActionForm
            action={addEncounterAction}
            hidden={{ org: page.ctx.org.slug, incidentId: incident.id, projectId: project.id }}
            submitLabel={t("incidents.addEncounter")}
            successKey="incidents.encounterAdded"
            resetOnSuccess
          >
            <TextField
              id="encounter-patient"
              name="patientDescription"
              label={t("incidents.patient")}
              help={t("incidents.patientHelp")}
              required
              maxLength={500}
              wide
            />
            <TextAreaField
              id="encounter-notes"
              name="treatmentNotes"
              label={t("incidents.treatmentNotes")}
              help={t("incidents.treatmentNotesHelp")}
              maxLength={4000}
            />
            <TextField
              id="encounter-disposition"
              name="disposition"
              label={t("incidents.disposition")}
              help={t("incidents.dispositionHelp")}
              maxLength={200}
            />
          </ActionForm>
        ) : null}
      </RecordSection>
      <RecordSection id="incident-history" title={t("incidents.historyHeading")}>
        {history.ok && history.data.length > 0 ? (
          <ol className="m-0 flex list-none flex-col gap-8 p-0">
            {history.data.map((h) => (
              <li key={h.id} className="flex flex-col gap-2 text-text-13">
                <span className="font-medium">
                  {h.fromState
                    ? t("incidents.historyMove", {
                        from: t(`incidents.states.${h.fromState}`),
                        to: t(`incidents.states.${h.toState}`),
                      })
                    : t("incidents.historyReported")}
                </span>
                <span className="text-text-12 text-text-secondary">
                  {joined(dateTime(format, h.at, timeZone), h.byName, h.reason)}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="m-0 text-text-13 text-text-secondary">{t("incidents.noHistory")}</p>
        )}
      </RecordSection>
      <CustomFieldsPanel org={page.ctx.org.slug} table="app.incidents" id={incident.id} />
      <RecordCollab
        page={page}
        table="app.incidents"
        id={incident.id}
        canChange={can(page, "safety.incident.write")}
      />
    </RecordChrome>
  );
}

// Dispatch board ------------------------------------------------------------------------------------

export async function DispatchBoardSection({ page }: { page: ModulePage }) {
  const t = page.t;
  const section = "dispatch";
  const format = await getFormatter();
  const [incidentsResult, severitiesResult] = await Promise.all([
    listIncidents(page.ctx.viewer.db, {
      orgId: page.ctx.org.id,
      ...(page.project ? { projectId: page.project.id } : {}),
      states: ["Reported", "Dispatched", "Contained"],
    }),
    listIncidentSeverities(page.ctx.viewer.db),
  ]);
  const severities = unwrap(severitiesResult, "severities");
  // Most severe first, then oldest: the queue a dispatcher works from (Section 11.11).
  const order = (i: Incident) => severities.find((s) => s.id === i.severityId)?.sortOrder ?? 99;
  const open = unwrap(incidentsResult, "incidents").sort(
    (a, b) => order(a) - order(b) || a.occurredAt.localeCompare(b.occurredAt),
  );
  const located = open.some((i) => i.latitude !== null);
  const declared = chooseView("safety.dispatch-board", param(page.search, "view"));
  const views = declared.views.filter((v) => v !== "map" || located);
  const view = views.includes(declared.view) ? declared.view : "board";
  const peekId = param(page.search, "peek");
  const title = t("nav.atlas.pages.safety.dispatchBoard");
  const peekHref = (i: Incident) =>
    sectionHref(page, { peek: i.id, full: undefined, section: undefined });
  const card = (i: Incident): ListItem => ({
    key: i.id,
    href: peekHref(i),
    title: joined(i.key, i.title),
    meta: joined(
      i.zoneCode,
      dateTime(format, i.occurredAt, projectOf(page, i.projectId)?.timeZone),
      t("incidents.responderCount", { count: i.responderCount }),
    ),
    trailing: <SeverityChip severities={severities} id={i.severityId} />,
  });

  return (
    <>
      <LiveRefresh seconds={2} />
      <Header
        page={page}
        section={section}
        title={title}
        count={open.length}
        views={views}
        view={view}

        action={
          can(page, "safety.incident.write") ? (
            <ButtonLink
              href={
                `/${page.ctx.org.slug}/safety/incidents?create=1${page.project ? `&project=${page.project.key}` : ""}` as Route
              }
              variant="primary"
            >
              {t("incidents.report")}
            </ButtonLink>
          ) : undefined
        }
      />
      <ProjectFilter page={page} section={section} />
      <p className="m-0 text-text-12 text-text-secondary" aria-live="polite">
        {t("incidents.liveNotice")}
      </p>
      {open.length === 0 ? (
        <EmptyStateLink
          icon="Radio"
          sentence={t("incidents.dispatchEmpty")}
          actionLabel={t("incidents.viewAll")}
          href={`/${page.ctx.org.slug}/safety/incidents` as Route}
        />
      ) : view === "map" ? (
        <IncidentMap page={page} incidents={open} peekHref={peekHref} />
      ) : (
        <TemplateSplitView
          listLabel={t("incidents.queue")}
          list={<OpsList label={t("incidents.queue")} items={open.map(card)} />}
          detail={
            <OpsBoard
              label={title}
              columns={(["Reported", "Dispatched", "Contained"] as const).map((s) => ({
                key: s,
                label: t(`incidents.states.${s}`),
                empty: t("incidents.boardEmpty"),
                items: open.filter((i) => i.state === s).map(card),
              }))}
            />
          }
        />
      )}
      {peekId ? (
        <IncidentRecord page={page} id={peekId} section={section} severities={severities} />
      ) : null}
    </>
  );
}

// Emergency codes ------------------------------------------------------------------------------------

const SWATCHES = new Set([
  "ecode-red",
  "ecode-orange",
  "ecode-yellow",
  "ecode-green",
  "ecode-blue",
  "ecode-purple",
  "ecode-white",
  "ecode-black",
  "ecode-pink",
  "ecode-indigo",
  "ecode-silver",
  "ecode-grey",
  "ecode-amber",
  "ecode-adam",
]);

export async function EmergencyCodesSection({ page }: { page: ModulePage }) {
  const t = page.t;
  const section = "codes";
  const format = await getFormatter();
  const { views, view } = chooseView("safety.emergency-codes", param(page.search, "view"));
  const [codesResult, alertsResult] = await Promise.all([
    listEmergencyCodes(page.ctx.viewer.db, page.ctx.org.id),
    listCrisisAlerts(page.ctx.viewer.db, {
      orgId: page.ctx.org.id,
      ...(page.project ? { projectId: page.project.id } : {}),
    }),
  ]);
  const codes = unwrap(codesResult, "emergency codes");
  const alerts = unwrap(alertsResult, "crisis alerts");
  const active = alerts.filter((a) => a.endedAt === null);
  const peek = param(page.search, "peek");
  const title = t("nav.atlas.pages.safety.emergencyCodes");
  const canAlert = can(page, "safety.incident.dispatch");
  const peekHref = (c: EmergencyCode) =>
    sectionHref(page, { peek: c.code, full: undefined, section: undefined });
  const columns: Column<EmergencyCode>[] = [
    { key: "label", label: t("incidents.codes.code"), primary: true, render: (c) => c.label },
    {
      key: "emergency",
      label: t("incidents.codes.emergency"),
      primary: true,
      render: (c) => c.emergency,
    },
    {
      key: "active",
      label: t("incidents.codes.activeAlerts"),
      numeric: true,
      primary: true,
      render: (c) => active.filter((a) => a.emergencyCode === c.code).length,
    },
  ];

  return (
    <>
      <Header
        page={page}
        section={section}
        title={title}
        count={codes.length}
        views={views}
        view={view}
      />
      <ProjectFilter page={page} section={section} />
      <p className="m-0 text-text-13 text-text-secondary">{t("incidents.codes.explain")}</p>
      {codes.length > 0 && codes.every((c) => c.id === undefined) ? (
        <p className="m-0 text-text-12 text-text-secondary" data-testid="emergency-codes-canon">
          {t("incidents.codes.notAdopted")}
        </p>
      ) : null}
      <AlertsPanel page={page} alerts={alerts} codes={codes} format={format} canAlert={canAlert} />
      {view === "list" ? (
        <OpsList
          label={title}
          items={codes.map((c) => ({
            key: c.code,
            href: peekHref(c),
            title: c.label,
            meta: c.emergency,
          }))}
        />
      ) : (
        <OpsTable
          caption={title}
          columns={columns}
          rows={codes}
          rowKey={(c) => c.code}
          rowHref={peekHref}
          selected={peek}
        />
      )}
      {peek ? <CodeRecord page={page} code={codes.find((c) => c.code === peek)} /> : null}
    </>
  );
}

function AlertsPanel({
  page,
  alerts,
  codes,
  format,
  canAlert,
}: {
  page: ModulePage;
  alerts: readonly CrisisAlert[];
  codes: readonly EmergencyCode[];
  format: Format;
  canAlert: boolean;
}) {
  const t = page.t;
  const active = alerts.filter((a) => a.endedAt === null);
  const label = (code: string) => codes.find((c) => c.code === code)?.label ?? code;
  return (
    <RecordSection id="crisis-alerts" title={t("incidents.alerts.heading")}>
      {active.length > 0 ? (
        <ul role="list" aria-live="polite" className="m-0 flex list-none flex-col gap-8 p-0">
          {active.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center justify-between gap-8 rounded-card border border-danger p-12"
            >
              <span className="flex flex-col gap-2">
                <span className="text-text-14 font-semibold">
                  {joined(label(a.emergencyCode), a.projectKey)}
                </span>
                <span className="text-text-13">{a.message}</span>
                <span className="text-text-12 text-text-secondary">
                  {t("incidents.alerts.issuedAt", {
                    time: dateTime(format, a.issuedAt, projectOf(page, a.projectId)?.timeZone),
                  })}
                </span>
              </span>
              {canAlert ? (
                <ActionForm
                  action={endAlertAction}
                  hidden={{ org: page.ctx.org.slug, id: a.id }}
                  submitLabel={t("incidents.alerts.allClear")}
                  successKey="incidents.alerts.cleared"
                  variant="secondary"
                  layout="inline"
                />
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-text-13 text-text-secondary">{t("incidents.alerts.none")}</p>
      )}
      {canAlert ? (
        page.project ? (
          <ActionForm
            action={issueAlertAction}
            hidden={{ org: page.ctx.org.slug, projectId: page.project.id }}
            submitLabel={t("incidents.alerts.issue")}
            successKey="incidents.alerts.issued"
            variant="danger"
            resetOnSuccess
          >
            <SelectField
              id="alert-code"
              name="emergencyCode"
              label={t("incidents.codes.code")}
              options={codes.map((c) => ({ value: c.code, label: joined(c.label, c.emergency) }))}
              required
            />
            <TextAreaField
              id="alert-message"
              name="message"
              label={t("incidents.alerts.message")}
              help={t("incidents.alerts.messageHelp")}
              required
              maxLength={1000}
            />
          </ActionForm>
        ) : (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("incidents.alerts.chooseProject")}
          </p>
        )
      ) : null}
      {alerts.length > active.length ? (
        <details>
          <summary className="cursor-pointer text-text-13 text-text-secondary">
            {t("incidents.alerts.past")}
          </summary>
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0 pt-8">
            {alerts
              .filter((a) => a.endedAt !== null)
              .map((a) => (
                <li key={a.id} className="py-6 text-text-13">
                  {joined(
                    label(a.emergencyCode),
                    a.projectKey,
                    a.message,
                    dateTime(format, a.issuedAt),
                  )}
                </li>
              ))}
          </ul>
        </details>
      ) : null}
    </RecordSection>
  );
}

async function CodeRecord({ page, code }: { page: ModulePage; code: EmergencyCode | undefined }) {
  const t = page.t;
  const closeHref = sectionHref(page, { peek: undefined, full: undefined, section: undefined });
  if (!code) return <RecordMissing page={page} closeHref={closeHref} />;
  const [protocols, authorities, channels] = await Promise.all([
    listEmergencyProtocols(page.ctx.viewer.db, code.code),
    page.project
      ? listProjectAuthorities(page.ctx.viewer.db, page.project.id)
      : Promise.resolve(null),
    page.project
      ? listRadioChannels(page.ctx.viewer.db, {
          orgId: page.ctx.org.id,
          projectId: page.project.id,
        })
      : Promise.resolve(null),
  ]);
  const authorityList = authorities?.ok ? authorities.data : [];
  const emergencyChannel = channels?.ok ? channels.data[0] : undefined;
  const swatch = SWATCHES.has(code.swatch) ? code.swatch : "ecode-grey";
  return (
    <RecordChrome
      page={page}
      full={param(page.search, "full") === "1"}
      title={code.label}
      recordKey={code.code}
      kindLabel={t("incidents.codes.kind")}
      closeHref={closeHref}
      fullHref={sectionHref(page, { peek: code.code, full: "1", section: undefined })}
      properties={
        <Properties
          label={t("credentials.common.properties")}
          rows={[
            { label: t("incidents.codes.emergency"), value: code.emergency },
            { label: t("incidents.codes.order"), value: code.sortOrder },
          ]}
        />
      }
    >
      {!page.project ? (
        <p className="m-0 text-text-12 text-text-secondary">
          {t("incidents.codes.genericAgencies")}
        </p>
      ) : null}
      {/* The codes are org data, edited with the org-wide capability (migration 1612). */}
      {code.id !== undefined && page.ctx.capabilities.has("safety.emergency_code.write") ? (
        <RecordSection id="emergency-code-edit" title={t("incidents.codes.editHeading")}>
          <ActionForm
            action={updateEmergencyCodeAction}
            hidden={{ org: page.ctx.org.slug, id: code.id }}
            submitLabel={t("credentials.common.save")}
            successKey="credentials.common.saved"
            layout="inline"
          >
            <TextField
              id="code-label"
              name="label"
              label={t("incidents.codes.labelField")}
              defaultValue={code.label}
              required
              maxLength={100}
            />
            <TextField
              id="code-emergency"
              name="emergency"
              label={t("incidents.codes.emergency")}
              defaultValue={code.emergency}
              required
              maxLength={200}
              wide
            />
            <TextField
              id="code-order"
              name="sortOrder"
              type="number"
              label={t("incidents.codes.order")}
              defaultValue={code.sortOrder}
              required
              min={1}
            />
          </ActionForm>
          <p className="m-0 text-text-12 text-text-secondary">
            {t("incidents.codes.canonWord", { code: code.code })}
          </p>
        </RecordSection>
      ) : null}
      {protocols.ok && protocols.data.length > 0 ? (
        <div className="flex flex-col gap-12">
          {protocols.data.map((p) => (
            <EmergencyCodeCard
              key={p.recordKey}
              recordKey={p.recordKey}
              code={code.code}
              name={code.label}
              swatch={swatch as "ecode-grey"}
              domain={p.domain}
              steps={[...p.steps]}
              authorities={authorityList}
              {...(emergencyChannel
                ? { channel: joined(String(emergencyChannel.channelNumber), emergencyChannel.name) }
                : {})}
            />
          ))}
        </div>
      ) : (
        <p className="m-0 text-text-13 text-text-secondary">{t("incidents.codes.noProtocols")}</p>
      )}
    </RecordChrome>
  );
}

// Radio channels ---------------------------------------------------------------------------------------

export async function RadioChannelsSection({ page }: { page: ModulePage }) {
  const t = page.t;
  const section = "radio";
  const { views, view } = chooseView("safety.radio-channels", param(page.search, "view"));
  const channels = unwrap(
    await listRadioChannels(page.ctx.viewer.db, {
      orgId: page.ctx.org.id,
      ...(page.project ? { projectId: page.project.id } : {}),
    }),
    "radio channels",
  );
  const canWrite = can(page, "safety.radio_channel.write");
  const zones = page.project
    ? unwrap(
        await listProjectZones(page.ctx.viewer.db, page.ctx.org.id, page.project.venueId),
        "zones",
      )
    : [];
  const creating = param(page.search, "create") === "1";
  const peekId = param(page.search, "peek");
  const title = t("nav.atlas.pages.safety.radioChannels");
  const peekHref = (c: RadioChannel) =>
    sectionHref(page, { peek: c.id, full: undefined, create: undefined, section: undefined });
  const zoneText = (c: RadioChannel) =>
    c.zoneCode ? joined(c.zoneCode, c.zoneName) : t("incidents.radio.allZones");
  const columns: Column<RadioChannel>[] = [
    {
      key: "channel",
      label: t("incidents.radio.channel"),
      primary: true,
      numeric: true,
      render: (c) => c.channelNumber,
    },
    { key: "name", label: t("incidents.radio.name"), primary: true, render: (c) => c.name },
    { key: "zone", label: t("incidents.zone"), primary: true, render: zoneText },
    { key: "project", label: t("credentials.common.project"), render: (c) => c.projectKey },
  ];

  return (
    <>
      <Header
        page={page}
        section={section}
        title={title}
        count={channels.length}
        views={views}
        view={view}

        action={
          canWrite ? (
            <ButtonLink
              href={sectionHref(page, { create: "1", peek: undefined, section: undefined })}
              variant="primary"
            >
              {t("incidents.radio.new")}
            </ButtonLink>
          ) : undefined
        }
      />
      <ProjectFilter page={page} section={section} />
      {creating && canWrite ? (
        page.project ? (
          <RecordSection id="new-channel" title={t("incidents.radio.new")}>
            <ActionForm
              action={createChannelAction}
              hidden={{ org: page.ctx.org.slug, projectId: page.project.id }}
              submitLabel={t("incidents.radio.create")}
              successKey="incidents.radio.created"
              layout="inline"
              resetOnSuccess
            >
              <TextField
                id="channel-number"
                name="channelNumber"
                type="number"
                min={1}
                required
                label={t("incidents.radio.channel")}
              />
              <TextField
                id="channel-name"
                name="name"
                required
                maxLength={200}
                label={t("incidents.radio.name")}
              />
              <ZoneSelect page={page} id="channel-zone" zones={zones} />
            </ActionForm>
            <ActionForm
              action={importPlanAction}
              hidden={{ org: page.ctx.org.slug, projectId: page.project.id }}
              submitLabel={t("incidents.radio.import")}
              successKey="incidents.radio.imported"
              layout="inline"
              variant="secondary"
            >
              <SelectField
                id="library-zone"
                name="libraryZone"
                label={t("incidents.radio.libraryGroup")}
                help={t("incidents.radio.libraryHelp")}
                options={[
                  { value: "1", label: t("incidents.radio.libraryOperations") },
                  { value: "2", label: t("incidents.radio.libraryShared") },
                ]}
              />
            </ActionForm>
          </RecordSection>
        ) : (
          chooseProjectNotice(page, section, {
            choose: t("incidents.radio.chooseProject"),
            none: t("incidents.noProjects"),
          })
        )
      ) : null}
      {channels.length === 0 ? (
        <EmptyStateLink
          icon="Radio"
          sentence={t("incidents.radio.empty")}
          actionLabel={t("incidents.radio.new")}
          href={sectionHref(page, { create: "1", section: undefined })}
        />
      ) : view === "list" ? (
        <OpsList
          label={title}
          items={channels.map((c) => ({
            key: c.id,
            href: peekHref(c),
            title: joined(String(c.channelNumber), c.name),
            meta: joined(zoneText(c), c.projectKey),
          }))}
        />
      ) : (
        <OpsTable
          caption={title}
          columns={columns}
          rows={channels}
          rowKey={(c) => c.id}
          rowHref={peekHref}
          selected={peekId}
        />
      )}
      {peekId ? (
        <ChannelRecord
          page={page}
          channel={channels.find((c) => c.id === peekId)}
          zones={zones}
          canWrite={canWrite}
        />
      ) : null}
    </>
  );
}

function ChannelRecord({
  page,
  channel,
  zones,
  canWrite,
}: {
  page: ModulePage;
  channel: RadioChannel | undefined;
  zones: readonly Zone[];
  canWrite: boolean;
}) {
  const t = page.t;
  const closeHref = sectionHref(page, { peek: undefined, full: undefined, section: undefined });
  if (!channel) return <RecordMissing page={page} closeHref={closeHref} />;
  return (
    <RecordChrome
      page={page}
      full={param(page.search, "full") === "1"}
      title={channel.name}
      recordKey={String(channel.channelNumber)}
      kindLabel={t("incidents.radio.kind")}
      closeHref={closeHref}
      fullHref={sectionHref(page, { peek: channel.id, full: "1", section: undefined })}
      properties={
        <Properties
          label={t("credentials.common.properties")}
          rows={[
            { label: t("incidents.radio.channel"), value: channel.channelNumber },
            {
              label: t("incidents.zone"),
              value: channel.zoneCode
                ? joined(channel.zoneCode, channel.zoneName)
                : t("incidents.radio.allZones"),
            },
            { label: t("credentials.common.project"), value: channel.projectKey },
          ]}
        />
      }
    >
      {canWrite ? (
        <>
          <RecordSection id="channel-edit" title={t("credentials.common.edit")}>
            <ActionForm
              action={updateChannelAction}
              hidden={{ org: page.ctx.org.slug, id: channel.id }}
              submitLabel={t("credentials.common.save")}
              successKey="credentials.common.saved"
              layout="inline"
            >
              <TextField
                id="edit-channel-number"
                name="channelNumber"
                type="number"
                min={1}
                required
                label={t("incidents.radio.channel")}
                defaultValue={channel.channelNumber}
              />
              <TextField
                id="edit-channel-name"
                name="name"
                required
                maxLength={200}
                label={t("incidents.radio.name")}
                defaultValue={channel.name}
              />
              <ZoneSelect
                page={page}
                id="edit-channel-zone"
                zones={zones}
                defaultValue={channel.zoneId}
              />
            </ActionForm>
          </RecordSection>
          <RecordSection id="channel-archive" title={t("incidents.radio.archiveHeading")}>
            <ActionForm
              action={archiveChannelAction}
              hidden={{ org: page.ctx.org.slug, id: channel.id }}
              submitLabel={t("incidents.radio.archive")}
              successKey="incidents.radio.archived"
              variant="danger"
            />
          </RecordSection>
        </>
      ) : null}
      <RecordCollab page={page} table="app.radio_channels" id={channel.id} canChange={canWrite} />
    </RecordChrome>
  );
}
