/**
 * Incidents (Section 4.3 item 5, Section 11.13 Incidents).
 *
 * A three-step quick report: severity from the canon Incident Severity grid, the location (filled from the
 * last fix), then photos or a note. Critical incidents use hold to confirm. Reports queue offline with
 * client ids, so a report filed in a dead zone lands once when the device reconnects.
 */
import { uuidv7, type MutationInput } from "@xos/sync";
import type { LocationFix } from "./geo";

/** A row of the canon Incident Severity enumeration, cached on device. */
export interface Severity {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly sortOrder: number;
  readonly colorCode: string | null;
}

/** The most severe level, read from canon order rather than retyped (mirrors private.is_critical_severity). */
export function isCritical(severity: Severity, all: readonly Severity[]): boolean {
  const top = Math.min(...all.map((s) => s.sortOrder));
  return severity.sortOrder === top;
}

/** Hold to confirm a critical report, so a pocket tap never raises one (Section 11.13). */
export const CRITICAL_HOLD_MS = 1_500;

export type IncidentStep = "severity" | "location" | "evidence" | "review";

export interface IncidentDraft {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly severityId: string | null;
  readonly title: string;
  readonly zoneId: string | null;
  readonly fix: LocationFix | null;
  readonly occurredAt: string;
  readonly photos: readonly {
    readonly id: string;
    readonly uri: string;
    readonly capturedAt: string;
  }[];
  readonly parties: readonly {
    readonly id: string;
    readonly personId: string | null;
    readonly description: string;
  }[];
}

export function newDraft(
  orgId: string,
  projectId: string,
  occurredAt: string,
  fix: LocationFix | null,
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): IncidentDraft {
  return {
    id: newId(nowMs),
    orgId,
    projectId,
    severityId: null,
    title: "",
    zoneId: null,
    fix,
    occurredAt,
    photos: [],
    parties: [],
  };
}

export type DraftProblem = "severity-missing" | "title-missing" | "title-too-long";

/** Inline validation, as the person types (Section 11.10 item 11). Title length matches the table check. */
export function draftProblems(draft: IncidentDraft): DraftProblem[] {
  const problems: DraftProblem[] = [];
  if (draft.severityId === null) problems.push("severity-missing");
  const title = draft.title.trim();
  if (title.length === 0) problems.push("title-missing");
  if (title.length > 200) problems.push("title-too-long");
  return problems;
}

export function nextStep(step: IncidentStep): IncidentStep {
  const order: IncidentStep[] = ["severity", "location", "evidence", "review"];
  return order[Math.min(order.indexOf(step) + 1, order.length - 1)] ?? "review";
}

/**
 * The queued writes for a report: the incident, then each photo and party, which depend on it so they never
 * upload before it does.
 */
export function buildReport(
  draft: IncidentDraft,
  nowMs: number,
  newId: (ms: number) => string = uuidv7,
): MutationInput[] {
  const problems = draftProblems(draft);
  if (problems.length > 0) throw new Error(`incident draft is not ready: ${problems.join(", ")}`);
  const incident = {
    id: draft.id,
    project_id: draft.projectId,
    title: draft.title.trim(),
    severity_enum_id: draft.severityId,
    zone_id: draft.zoneId,
    occurred_at: draft.occurredAt,
    latitude: draft.fix?.latitude ?? null,
    longitude: draft.fix?.longitude ?? null,
    accuracy_m: draft.fix?.accuracyM ?? null,
    device_reported_at: new Date(nowMs).toISOString(),
    incident_state: "Reported",
  };
  // A14's field RPCs (0471), allowlisted for app.apply_sync_mutation: each takes the device-minted id,
  // so a replay finds the row it already wrote instead of filing a second report.
  const writes: MutationInput[] = [
    {
      op: "rpc",
      target: "app.report_incident",
      table: "incidents",
      rowId: draft.id,
      payload: {
        p_id: incident.id,
        p_project_id: incident.project_id,
        p_title: incident.title,
        p_severity_enum_id: incident.severity_enum_id,
        p_occurred_at: incident.occurred_at,
        p_zone_id: incident.zone_id,
        p_latitude: incident.latitude,
        p_longitude: incident.longitude,
        p_accuracy_m: incident.accuracy_m,
        p_device_reported_at: incident.device_reported_at,
      },
      policy: "append",
      optimistic: incident,
    },
  ];
  for (const photo of draft.photos) {
    // The object name the field-media bucket policy expects: <org_id>/incidents/<incident_id>/<file>.
    const path = `${draft.orgId}/incidents/${draft.id}/${photo.id}.jpg`;
    const row = {
      id: photo.id,
      incident_id: draft.id,
      project_id: draft.projectId,
      media_uri: path,
      captured_at: photo.capturedAt,
    };
    writes.push({
      op: "rpc",
      target: "app.add_incident_media",
      table: "incident_media",
      rowId: photo.id,
      payload: {
        p_id: photo.id,
        p_incident_id: draft.id,
        p_media_uri: path,
        p_captured_at: photo.capturedAt,
        // Device-only: the uploader sends the file to the field-media bucket before the RPC.
        local_uri: photo.uri,
        storage_path: path,
      },
      policy: "append",
      optimistic: row,
    });
  }
  for (const party of draft.parties) {
    const row = {
      id: party.id || newId(nowMs),
      incident_id: draft.id,
      person_id: party.personId,
      description: party.description,
    };
    writes.push({
      op: "rpc",
      target: "app.add_incident_party",
      table: "incident_parties",
      rowId: row.id,
      payload: {
        p_id: row.id,
        p_incident_id: row.incident_id,
        p_description: row.description,
        p_person_id: row.person_id,
      },
      policy: "append",
      optimistic: row,
    });
  }
  return writes;
}

/** Marks every write after the first as depending on the incident's queued mutation. */
export function withIncidentDependency(
  writes: readonly MutationInput[],
  incidentMutationId: string,
): MutationInput[] {
  return writes.slice(1).map((w) => ({ ...w, dependsOn: [incidentMutationId] }));
}

export interface IncidentRow {
  readonly id: string;
  readonly incident_number: number | null;
  readonly title: string;
  readonly severity_enum_id: string;
  readonly incident_state: "Reported" | "Dispatched" | "Contained" | "Closed";
  readonly occurred_at: string;
  readonly zone_id: string | null;
}

/**
 * The supervisor dispatch queue (Section 11.11 Safety): open incidents, most severe first, then oldest
 * first. Unnumbered rows are the device's own queued reports.
 */
export function dispatchQueue(
  incidents: readonly IncidentRow[],
  severities: readonly Severity[],
): IncidentRow[] {
  const rank = new Map(severities.map((s) => [s.id, s.sortOrder]));
  return incidents
    .filter((i) => i.incident_state !== "Closed")
    .sort(
      (a, b) =>
        (rank.get(a.severity_enum_id) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(b.severity_enum_id) ?? Number.MAX_SAFE_INTEGER) ||
        Date.parse(a.occurred_at) - Date.parse(b.occurred_at),
    );
}

/** Dispatch and contain go through app.transition_incident (allowlisted) with compare-and-set. */
export function buildTransition(
  incident: IncidentRow,
  next: "Dispatched" | "Contained",
  reason: string,
): MutationInput {
  return {
    op: "rpc",
    target: "app.transition_incident",
    table: "incidents",
    rowId: incident.id,
    payload: {
      p_incident_id: incident.id,
      p_expected: incident.incident_state,
      p_next: next,
      p_reason: reason,
    },
    policy: "cas",
    optimistic: { ...incident, incident_state: next },
  };
}
