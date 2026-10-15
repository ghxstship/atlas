import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";

/**
 * Safety incidents repository (Section 4.2 Safety, Section 7.4, invariant 22): incidents with their
 * CAD lifecycle, parties, media, dispatch, medical encounters, crisis alerts under the global
 * emergency codes, and the radio plan. Reads go through row level security; writes through the
 * guards and RPCs of migrations 0353 and 0470. Closing always goes through app.close_incident, which
 * records sign-off. Medical treatment notes are Restricted: they are read only through
 * app.medical_encounters_masked and are never exported or sent to a model (Section 14.3).
 */

// Severity -------------------------------------------------------------------------------------

/** A canon Incident Severity (Bible enumerations). The first in canon order is critical. */
export interface IncidentSeverity {
  readonly id: string;
  readonly code: string;
  readonly label: string;
  readonly sortOrder: number;
  readonly isCritical: boolean;
}

export async function listIncidentSeverities(db: XosClient): Promise<Result<IncidentSeverity[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("std_enumeration")
    .select("record_id, enum_code, enum_label, sort_order")
    .eq("enum_domain", "Incident Severity")
    .order("sort_order");
  if (error) return fail(toDataError(error));
  const rows = data as {
    record_id: string;
    enum_code: string | null;
    enum_label: string | null;
    sort_order: number | null;
  }[];
  const first = rows.length > 0 ? Math.min(...rows.map((r) => Number(r.sort_order ?? 0))) : null;
  return ok(
    rows.map((r) => ({
      id: r.record_id,
      code: r.enum_code ?? r.record_id,
      label: r.enum_label ?? r.record_id,
      sortOrder: Number(r.sort_order ?? 0),
      isCritical: Number(r.sort_order ?? 0) === first,
    })),
  );
}

// Incidents ------------------------------------------------------------------------------------

export type IncidentState = "Reported" | "Dispatched" | "Contained" | "Closed";

export const INCIDENT_STATES: readonly IncidentState[] = [
  "Reported",
  "Dispatched",
  "Contained",
  "Closed",
];

/**
 * The moves the database allows (private.lifecycle_transition_rules, lifecycle incident). Closed is
 * reached only from Contained and only through closeIncident.
 */
export const INCIDENT_MOVES: Readonly<Record<IncidentState, readonly IncidentState[]>> = {
  Reported: ["Dispatched", "Contained"],
  Dispatched: ["Contained"],
  Contained: ["Dispatched", "Closed"],
  Closed: [],
};

export interface Incident {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly number: number;
  /** Display key, {projectKey}-{number} (Section 4.5.1). */
  readonly key: string;
  readonly title: string;
  readonly severityId: string;
  readonly zoneId: string | null;
  readonly zoneCode: string | null;
  readonly zoneName: string | null;
  readonly occurredAt: string;
  readonly reportedById: string | null;
  readonly reportedByName: string | null;
  readonly state: IncidentState;
  readonly closedSignedOffByName: string | null;
  readonly latitude: number | null;
  readonly longitude: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Responders dispatched and not withdrawn. */
  readonly responderCount: number;
}

interface IncidentRow {
  id: string;
  project_id: string;
  incident_number: number;
  title: string;
  severity_enum_id: string;
  zone_id: string | null;
  occurred_at: string;
  reported_by: string | null;
  incident_state: IncidentState;
  latitude?: number | string | null;
  longitude?: number | string | null;
  created_at: string;
  updated_at: string;
  project: { project_key: string } | null;
  zone: { code: string; name: string } | null;
  reporter: { full_name: string | null } | null;
  signer: { full_name: string | null } | null;
  dispatch_assignments: { deleted_at: string | null }[] | null;
}

const INCIDENT_COLUMNS = [
  "id, project_id, incident_number, title, severity_enum_id, zone_id, occurred_at, reported_by, incident_state, latitude, longitude, created_at, updated_at",
  "project:projects!incidents_project_id_fkey(project_key)",
  "zone:zones(code, name)",
  "reporter:people!incidents_reported_by_fkey(full_name)",
  "signer:people!incidents_closed_signed_off_by_fkey(full_name)",
  "dispatch_assignments(deleted_at)",
].join(", ");

function toNumber(value: number | string | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

function toIncident(row: IncidentRow): Incident {
  const projectKey = row.project?.project_key ?? "";
  return {
    id: row.id,
    projectId: row.project_id,
    projectKey,
    number: row.incident_number,
    key: `${projectKey}-${row.incident_number}`,
    title: row.title,
    severityId: row.severity_enum_id,
    zoneId: row.zone_id,
    zoneCode: row.zone?.code ?? null,
    zoneName: row.zone?.name ?? null,
    occurredAt: row.occurred_at,
    reportedById: row.reported_by,
    reportedByName: row.reporter?.full_name ?? null,
    state: row.incident_state,
    closedSignedOffByName: row.signer?.full_name ?? null,
    latitude: toNumber(row.latitude),
    longitude: toNumber(row.longitude),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    responderCount: (row.dispatch_assignments ?? []).filter((d) => !d.deleted_at).length,
  };
}

export interface IncidentFilter {
  readonly orgId: string;
  readonly projectId?: string;
  readonly states?: readonly IncidentState[];
}

/** Incidents, most recent first. */
export async function listIncidents(
  db: XosClient,
  filter: IncidentFilter,
): Promise<Result<Incident[]>> {
  let query = db
    .from("incidents")
    .select(INCIDENT_COLUMNS)
    .eq("org_id", filter.orgId)
    .is("deleted_at", null);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  if (filter.states && filter.states.length > 0)
    query = query.in("incident_state", [...filter.states]);
  const { data, error } = await query.order("occurred_at", { ascending: false }).limit(1000);
  if (error) return fail(toDataError(error));
  return ok((data as unknown as IncidentRow[]).map(toIncident));
}

/** Open incidents for the dispatch board and Compass dispatch (A17): everything not closed. */
export function listIncidentsForDispatch(
  db: XosClient,
  orgId: string,
  projectId?: string,
): Promise<Result<Incident[]>> {
  return listIncidents(db, {
    orgId,
    ...(projectId ? { projectId } : {}),
    states: ["Reported", "Dispatched", "Contained"],
  });
}

export async function getIncident(db: XosClient, id: string): Promise<Result<Incident>> {
  const { data, error } = await db
    .from("incidents")
    .select(INCIDENT_COLUMNS)
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return fail(toDataError(error));
  if (!data) return fail({ kind: "not-found" });
  return ok(toIncident(data as unknown as IncidentRow));
}

export interface ReportIncidentInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly title: string;
  readonly severityId: string;
  readonly occurredAt: string;
  readonly zoneId?: string | null;
  /** A client UUIDv7 that becomes the row id, so an offline replay returns the stored incident. */
  readonly id?: string;
  readonly latitude?: number;
  readonly longitude?: number;
  readonly accuracyM?: number;
  /** When the reporter filed it on the device, for a report queued offline. */
  readonly deviceAt?: string;
}

export interface ReportedIncident {
  readonly id: string;
  readonly incidentNumber: number;
  readonly incidentState: IncidentState;
  readonly replayed: boolean;
}

/**
 * Reports an incident through app.report_incident (migration 0471). The database sets the reporter
 * from the session, numbers it from the project sequence, checks the canon severity and refuses a
 * closed production. A client id makes a replay return the stored incident with `replayed`.
 */
export async function reportIncident(
  db: XosClient,
  input: ReportIncidentInput,
): Promise<Result<ReportedIncident>> {
  const located = input.latitude !== undefined && input.longitude !== undefined;
  const { data, error } = await db.rpc("report_incident", {
    p_project_id: input.projectId,
    p_title: input.title.trim(),
    p_severity_enum_id: input.severityId,
    p_occurred_at: input.occurredAt,
    ...(input.zoneId ? { p_zone_id: input.zoneId } : {}),
    ...(located
      ? { p_latitude: input.latitude as number, p_longitude: input.longitude as number }
      : {}),
    ...(located && input.accuracyM !== undefined ? { p_accuracy_m: input.accuracyM } : {}),
    ...(input.deviceAt ? { p_device_reported_at: input.deviceAt } : {}),
    ...(input.id ? { p_id: input.id } : {}),
  });
  if (error) return fail(toDataError(error));
  const row = (
    data as
      | { id: string; incident_number: number; incident_state: IncidentState; replayed: boolean }[]
      | null
  )?.[0];
  if (!row) return fail({ kind: "not-found" });
  return ok({
    id: row.id,
    incidentNumber: row.incident_number,
    incidentState: row.incident_state,
    replayed: row.replayed,
  });
}

export interface IncidentEdit {
  readonly title: string;
  readonly severityId: string;
  readonly zoneId: string | null;
  readonly occurredAt: string;
}

/** Edits an open incident. A closed incident is never relabeled (invariant 22). */
export async function updateIncident(
  db: XosClient,
  id: string,
  edit: IncidentEdit,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("incidents")
    .update({
      title: edit.title.trim(),
      severity_enum_id: edit.severityId,
      zone_id: edit.zoneId,
      occurred_at: edit.occurredAt,
    })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail({ kind: "not-found" }) : ok(null);
}

/**
 * Dispatches or contains an incident with compare-and-set: the move fails with a refusal when the
 * incident is no longer in `expected`. Closing goes through closeIncident.
 */
export async function transitionIncident(
  db: XosClient,
  input: {
    readonly id: string;
    readonly expected: IncidentState;
    readonly next: Exclude<IncidentState, "Closed">;
    readonly reason: string;
  },
): Promise<Result<null>> {
  const { error } = await db.rpc("transition_incident", {
    p_incident_id: input.id,
    p_expected: input.expected,
    p_next: input.next,
    p_reason: input.reason.trim(),
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

/**
 * Closes a contained incident with sign-off (invariant 22). A critical incident is signed off by
 * someone other than its reporter (`sod_approval_requester`).
 */
export async function closeIncident(
  db: XosClient,
  id: string,
  signoffNote: string,
): Promise<Result<null>> {
  const { error } = await db.rpc("close_incident", {
    p_incident_id: id,
    p_signoff_note: signoffNote.trim(),
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

export interface IncidentTransition {
  readonly id: string;
  readonly fromState: IncidentState | null;
  readonly toState: IncidentState;
  readonly reason: string;
  readonly at: string;
  readonly byName: string | null;
}

/** The incident's state ledger, oldest first. */
export async function listIncidentHistory(
  db: XosClient,
  incidentId: string,
): Promise<Result<IncidentTransition[]>> {
  const { data, error } = await db
    .from("incident_state_transitions")
    .select(
      "id, from_state, to_state, reason, created_at, by:people!incident_state_transitions_created_by_fkey(full_name)",
    )
    .eq("incident_id", incidentId)
    .order("created_at");
  if (error) return fail(toDataError(error));
  return ok(
    (
      data as unknown as {
        id: string;
        from_state: IncidentState | null;
        to_state: IncidentState;
        reason: string;
        created_at: string;
        by: { full_name: string | null } | null;
      }[]
    ).map((r) => ({
      id: r.id,
      fromState: r.from_state,
      toState: r.to_state,
      reason: r.reason,
      at: r.created_at,
      byName: r.by?.full_name ?? null,
    })),
  );
}

// Parties --------------------------------------------------------------------------------------

export interface IncidentParty {
  readonly id: string;
  readonly personId: string | null;
  readonly personName: string | null;
  readonly description: string;
}

export async function listIncidentParties(
  db: XosClient,
  incidentId: string,
): Promise<Result<IncidentParty[]>> {
  const { data, error } = await db
    .from("incident_parties")
    .select("id, person_id, description, person:people!incident_parties_person_id_fkey(full_name)")
    .eq("incident_id", incidentId)
    .is("deleted_at", null)
    .order("created_at");
  if (error) return fail(toDataError(error));
  return ok(
    (
      data as unknown as {
        id: string;
        person_id: string | null;
        description: string;
        person: { full_name: string | null } | null;
      }[]
    ).map((r) => ({
      id: r.id,
      personId: r.person_id,
      personName: r.person?.full_name ?? null,
      description: r.description,
    })),
  );
}

/** Adds a party through app.add_incident_party. Idempotent on a client id for Compass replays (A17). */
export async function addIncidentParty(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly incidentId: string;
    readonly personId?: string | null;
    readonly description: string;
    readonly id?: string;
  },
): Promise<Result<{ id: string; replayed: boolean }>> {
  const { data, error } = await db.rpc("add_incident_party", {
    p_incident_id: input.incidentId,
    p_description: input.description.trim(),
    ...(input.personId ? { p_person_id: input.personId } : {}),
    ...(input.id ? { p_id: input.id } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data, replayed: false });
}

export async function removeIncidentParty(db: XosClient, id: string): Promise<Result<null>> {
  return softDelete(db, "incident_parties", id);
}

// Media ----------------------------------------------------------------------------------------

export interface IncidentMedia {
  readonly id: string;
  readonly mediaUri: string;
  readonly capturedAt: string | null;
  readonly createdAt: string;
}

export async function listIncidentMedia(
  db: XosClient,
  incidentId: string,
): Promise<Result<IncidentMedia[]>> {
  const { data, error } = await db
    .from("incident_media")
    .select("id, media_uri, captured_at, created_at")
    .eq("incident_id", incidentId)
    .is("deleted_at", null)
    .order("created_at");
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.id,
      mediaUri: r.media_uri,
      capturedAt: r.captured_at,
      createdAt: r.created_at,
    })),
  );
}

/** Attaches a photo or video already stored, through app.add_incident_media. Idempotent on a client id. */
export async function addIncidentMedia(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly incidentId: string;
    readonly mediaUri: string;
    readonly capturedAt?: string | null;
    readonly id?: string;
  },
): Promise<Result<{ id: string; replayed: boolean }>> {
  const { data, error } = await db.rpc("add_incident_media", {
    p_incident_id: input.incidentId,
    p_media_uri: input.mediaUri,
    ...(input.capturedAt ? { p_captured_at: input.capturedAt } : {}),
    ...(input.id ? { p_id: input.id } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data, replayed: false });
}

export async function removeIncidentMedia(db: XosClient, id: string): Promise<Result<null>> {
  return softDelete(db, "incident_media", id);
}

// Dispatch -------------------------------------------------------------------------------------

export interface DispatchAssignment {
  readonly id: string;
  readonly incidentId: string;
  readonly membershipId: string;
  readonly responderName: string | null;
  readonly dispatchedAt: string;
  readonly arrivedAt: string | null;
}

interface DispatchRow {
  id: string;
  incident_id: string;
  membership_id: string;
  dispatched_at: string;
  arrived_at: string | null;
  membership: { person: { full_name: string | null } | null } | null;
}

const DISPATCH_COLUMNS =
  "id, incident_id, membership_id, dispatched_at, arrived_at, membership:memberships(person:people!memberships_person_id_fkey(full_name))";

function toDispatch(r: DispatchRow): DispatchAssignment {
  return {
    id: r.id,
    incidentId: r.incident_id,
    membershipId: r.membership_id,
    responderName: r.membership?.person?.full_name ?? null,
    dispatchedAt: r.dispatched_at,
    arrivedAt: r.arrived_at,
  };
}

/** Responders on the given incidents, in dispatch order. */
export async function listDispatchAssignments(
  db: XosClient,
  incidentIds: readonly string[],
): Promise<Result<DispatchAssignment[]>> {
  if (incidentIds.length === 0) return ok([]);
  const { data, error } = await db
    .from("dispatch_assignments")
    .select(DISPATCH_COLUMNS)
    .in("incident_id", [...incidentIds])
    .is("deleted_at", null)
    .order("dispatched_at");
  if (error) return fail(toDataError(error));
  return ok((data as unknown as DispatchRow[]).map(toDispatch));
}

/** The signed-in responder's open dispatches, for Compass (A17). */
export async function listMyDispatches(
  db: XosClient,
  membershipIds: readonly string[],
): Promise<Result<DispatchAssignment[]>> {
  if (membershipIds.length === 0) return ok([]);
  const { data, error } = await db
    .from("dispatch_assignments")
    .select(DISPATCH_COLUMNS)
    .in("membership_id", [...membershipIds])
    .is("deleted_at", null)
    .is("arrived_at", null)
    .order("dispatched_at");
  if (error) return fail(toDataError(error));
  return ok((data as unknown as DispatchRow[]).map(toDispatch));
}

/** Dispatches a responder through app.dispatch_responder (safety.incident.dispatch). Idempotent on a client id. */
export async function dispatchResponder(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly incidentId: string;
    readonly membershipId: string;
    readonly id?: string;
  },
): Promise<Result<{ id: string; replayed: boolean }>> {
  const { data, error } = await db.rpc("dispatch_responder", {
    p_incident_id: input.incidentId,
    p_membership_id: input.membershipId,
    ...(input.id ? { p_id: input.id } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data, replayed: false });
}

/**
 * Records the responder's arrival through app.mark_dispatch_arrived, by the responder or a
 * dispatcher. A second call keeps the first arrival time and returns it.
 */
export async function markArrived(
  db: XosClient,
  id: string,
): Promise<Result<{ arrivedAt: string }>> {
  const { data, error } = await db.rpc("mark_dispatch_arrived", { p_dispatch_assignment_id: id });
  if (error) return fail(toDataError(error));
  return ok({ arrivedAt: data });
}

export async function withdrawResponder(db: XosClient, id: string): Promise<Result<null>> {
  return softDelete(db, "dispatch_assignments", id);
}

// Medical encounters (Restricted) ---------------------------------------------------------------

export interface MedicalEncounter {
  readonly id: string;
  readonly incidentId: string;
  readonly patientDescription: string;
  readonly disposition: string | null;
  /** Null when masked: the caller lacks data.restricted.read.medical. */
  readonly treatmentNotes: string | null;
  readonly isMasked: boolean;
}

/** Encounters through the masked view only; the base table's notes are never selected. */
export async function listMedicalEncounters(
  db: XosClient,
  incidentId: string,
): Promise<Result<MedicalEncounter[]>> {
  const { data, error } = await db
    .from("medical_encounters_masked")
    .select("id, incident_id, patient_description, disposition, treatment_notes, is_masked")
    .eq("incident_id", incidentId);
  if (error) return fail(toDataError(error));
  return ok(
    data.map((r) => ({
      id: r.id ?? "",
      incidentId: r.incident_id ?? incidentId,
      patientDescription: r.patient_description ?? "",
      disposition: r.disposition,
      treatmentNotes: r.treatment_notes,
      isMasked: r.is_masked ?? true,
    })),
  );
}

/**
 * Records a medical encounter through app.record_medical_encounter (A03F 0363), which encrypts the
 * treatment notes before they reach the table. Only the id comes back, so the notes never travel
 * back to the caller. The Atlas action requires data.restricted.read.medical before calling this.
 */
export async function addMedicalEncounter(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly incidentId: string;
    readonly patientDescription: string;
    readonly treatmentNotes: string | null;
    readonly disposition: string | null;
  },
): Promise<Result<{ id: string }>> {
  const notes = input.treatmentNotes?.trim();
  const disposition = input.disposition?.trim();
  const { data, error } = await db.rpc("record_medical_encounter", {
    p_incident_id: input.incidentId,
    p_patient_description: input.patientDescription.trim(),
    ...(notes ? { p_treatment_notes: notes } : {}),
    ...(disposition ? { p_disposition: disposition } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok({ id: data });
}

/** Updates a medical encounter through app.update_medical_encounter; an omitted value is kept. */
export async function updateMedicalEncounter(
  db: XosClient,
  id: string,
  input: {
    readonly patientDescription?: string;
    readonly treatmentNotes?: string;
    readonly disposition?: string;
  },
): Promise<Result<null>> {
  const { error } = await db.rpc("update_medical_encounter", {
    p_medical_encounter_id: id,
    ...(input.patientDescription?.trim()
      ? { p_patient_description: input.patientDescription.trim() }
      : {}),
    ...(input.treatmentNotes?.trim() ? { p_treatment_notes: input.treatmentNotes.trim() } : {}),
    ...(input.disposition?.trim() ? { p_disposition: input.disposition.trim() } : {}),
  });
  if (error) return fail(toDataError(error));
  return ok(null);
}

// Crisis alerts and emergency codes --------------------------------------------------------------

/** One global emergency code (decision D15), in canon order. */
export interface EmergencyCode {
  readonly code: string;
  readonly label: string;
  readonly emergency: string;
  readonly swatch: string;
  readonly sortOrder: number;
}

export interface EmergencyProtocol {
  readonly recordKey: string;
  readonly code: string;
  readonly domain: string;
  readonly notes: string | null;
  readonly steps: readonly string[];
}

export async function listEmergencyCodes(db: XosClient): Promise<Result<EmergencyCode[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("emergency_code")
    .select("code, label, emergency, swatch, sort_order")
    .order("sort_order");
  if (error) return fail(toDataError(error));
  return ok(
    (
      data as {
        code: string;
        label: string;
        emergency: string;
        swatch: string;
        sort_order: number;
      }[]
    ).map((r) => ({
      code: r.code,
      label: r.label,
      emergency: r.emergency,
      swatch: r.swatch,
      sortOrder: r.sort_order,
    })),
  );
}

/** The protocols of the global codes per operational domain, with their steps, in key order. */
export async function listEmergencyProtocols(
  db: XosClient,
  code?: string,
): Promise<Result<EmergencyProtocol[]>> {
  let query = db
    .schema("xpms")
    .from("emergency_protocol")
    .select("record_key, code, domain, notes, steps:emergency_protocol_step(step_no, body)");
  if (code) query = query.eq("code", code);
  const { data, error } = await query.order("record_key");
  if (error) return fail(toDataError(error));
  return ok(
    (
      data as unknown as {
        record_key: string;
        code: string;
        domain: string;
        notes: string | null;
        steps: ProtocolStepRow[] | null;
      }[]
    ).map((r) => ({
      recordKey: r.record_key,
      code: r.code,
      domain: r.domain,
      notes: r.notes,
      steps: stepTexts(r.steps ?? []),
    })),
  );
}

/** Protocol steps in step order. */
function stepTexts(steps: readonly ProtocolStepRow[]): string[] {
  return [...steps].sort((a, b) => a.step_no - b.step_no).map((s) => s.body);
}

interface ProtocolStepRow {
  step_no: number;
  body: string;
}

export interface CrisisAlert {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly emergencyCode: string;
  readonly message: string;
  readonly issuedAt: string;
  readonly endedAt: string | null;
}

export async function listCrisisAlerts(
  db: XosClient,
  filter: { readonly orgId: string; readonly projectId?: string; readonly activeOnly?: boolean },
): Promise<Result<CrisisAlert[]>> {
  let query = db
    .from("crisis_alerts")
    .select(
      "id, project_id, emergency_code, message, issued_at, ended_at, project:projects!crisis_alerts_project_id_fkey(project_key)",
    )
    .eq("org_id", filter.orgId)
    .is("deleted_at", null);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  if (filter.activeOnly) query = query.is("ended_at", null);
  const { data, error } = await query.order("issued_at", { ascending: false }).limit(200);
  if (error) return fail(toDataError(error));
  return ok(
    (
      data as unknown as {
        id: string;
        project_id: string;
        emergency_code: string;
        message: string;
        issued_at: string;
        ended_at: string | null;
        project: { project_key: string } | null;
      }[]
    ).map((r) => ({
      id: r.id,
      projectId: r.project_id,
      projectKey: r.project?.project_key ?? "",
      emergencyCode: r.emergency_code,
      message: r.message,
      issuedAt: r.issued_at,
      endedAt: r.ended_at,
    })),
  );
}

/** Announces a crisis alert under a global code (safety.incident.dispatch on the project). */
export async function issueCrisisAlert(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly projectId: string;
    readonly emergencyCode: string;
    readonly message: string;
  },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("crisis_alerts")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      emergency_code: input.emergencyCode,
      message: input.message.trim(),
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

/** Gives the all-clear for an alert. */
export async function endCrisisAlert(db: XosClient, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("crisis_alerts")
    .update({ ended_at: new Date().toISOString() })
    .eq("id", id)
    .is("ended_at", null)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail({ kind: "not-found" }) : ok(null);
}

// Radio plan -----------------------------------------------------------------------------------

export interface RadioChannel {
  readonly id: string;
  readonly projectId: string;
  readonly projectKey: string;
  readonly channelNumber: number;
  readonly name: string;
  readonly zoneId: string | null;
  readonly zoneCode: string | null;
  readonly zoneName: string | null;
}

/** The radio plan, in project key then channel number order (Section 3.6). */
export async function listRadioChannels(
  db: XosClient,
  filter: { readonly orgId: string; readonly projectId?: string },
): Promise<Result<RadioChannel[]>> {
  let query = db
    .from("radio_channels")
    .select(
      "id, project_id, channel_number, name, zone_id, zone:zones(code, name), project:projects!radio_channels_project_id_fkey(project_key)",
    )
    .eq("org_id", filter.orgId)
    .is("deleted_at", null);
  if (filter.projectId) query = query.eq("project_id", filter.projectId);
  const { data, error } = await query.order("channel_number");
  if (error) return fail(toDataError(error));
  const rows = (
    data as unknown as {
      id: string;
      project_id: string;
      channel_number: number;
      name: string;
      zone_id: string | null;
      zone: { code: string; name: string } | null;
      project: { project_key: string } | null;
    }[]
  ).map((r) => ({
    id: r.id,
    projectId: r.project_id,
    projectKey: r.project?.project_key ?? "",
    channelNumber: r.channel_number,
    name: r.name,
    zoneId: r.zone_id,
    zoneCode: r.zone?.code ?? null,
    zoneName: r.zone?.name ?? null,
  }));
  return ok(
    rows.sort(
      (a, b) => a.projectKey.localeCompare(b.projectKey) || a.channelNumber - b.channelNumber,
    ),
  );
}

export interface RadioChannelInput {
  readonly channelNumber: number;
  readonly name: string;
  readonly zoneId: string | null;
}

export async function createRadioChannel(
  db: XosClient,
  input: RadioChannelInput & { readonly orgId: string; readonly projectId: string },
): Promise<Result<{ id: string }>> {
  const { data, error } = await db
    .from("radio_channels")
    .insert({
      org_id: input.orgId,
      project_id: input.projectId,
      channel_number: input.channelNumber,
      name: input.name.trim(),
      zone_id: input.zoneId,
    })
    .select("id")
    .single();
  if (error) return fail(toDataError(error));
  return ok({ id: data.id });
}

export async function updateRadioChannel(
  db: XosClient,
  id: string,
  input: RadioChannelInput,
): Promise<Result<null>> {
  const { data, error } = await db
    .from("radio_channels")
    .update({ channel_number: input.channelNumber, name: input.name.trim(), zone_id: input.zoneId })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail({ kind: "not-found" }) : ok(null);
}

export async function archiveRadioChannel(db: XosClient, id: string): Promise<Result<null>> {
  return softDelete(db, "radio_channels", id);
}

/** One row of the XOS Standard Library radio plan (xpms.std_radio_channel). */
export interface StandardRadioChannel {
  readonly recordId: string;
  readonly zone: number | null;
  readonly channel: number | null;
  readonly assignment: string;
  readonly notes: string | null;
}

export async function listStandardRadioChannels(
  db: XosClient,
): Promise<Result<StandardRadioChannel[]>> {
  const { data, error } = await db
    .schema("xpms")
    .from("std_radio_channel")
    .select("record_id, zone, channel, assignment, notes")
    .order("zone")
    .order("channel");
  if (error) return fail(toDataError(error));
  return ok(
    (
      data as {
        record_id: string;
        zone: number | null;
        channel: number | null;
        assignment: string | null;
        notes: string | null;
      }[]
    ).map((r) => ({
      recordId: r.record_id,
      zone: toNumber(r.zone),
      channel: toNumber(r.channel),
      assignment: r.assignment ?? r.record_id,
      notes: r.notes,
    })),
  );
}

/**
 * Starts a project's radio plan from one zone group of the Standard Library: one channel per row,
 * numbered and named as the library has them. Channels the project already uses are skipped.
 */
export async function importStandardRadioPlan(
  db: XosClient,
  input: { readonly orgId: string; readonly projectId: string; readonly libraryZone: number },
): Promise<Result<{ added: number }>> {
  const [library, existing] = await Promise.all([
    listStandardRadioChannels(db),
    listRadioChannels(db, { orgId: input.orgId, projectId: input.projectId }),
  ]);
  if (!library.ok) return library;
  if (!existing.ok) return existing;
  const used = new Set(existing.data.map((c) => c.channelNumber));
  const rows = library.data
    .filter((r) => r.zone === input.libraryZone && r.channel !== null && !used.has(r.channel))
    .map((r) => ({
      org_id: input.orgId,
      project_id: input.projectId,
      channel_number: r.channel as number,
      name: r.assignment,
    }));
  if (rows.length === 0) return ok({ added: 0 });
  const { error } = await db.from("radio_channels").insert(rows);
  if (error) return fail(toDataError(error));
  return ok({ added: rows.length });
}

// Shared ---------------------------------------------------------------------------------------

type SoftDeletable =
  "incident_parties" | "incident_media" | "dispatch_assignments" | "radio_channels";

async function softDelete(db: XosClient, table: SoftDeletable, id: string): Promise<Result<null>> {
  const { data, error } = await db
    .from(table)
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null)
    .select("id");
  if (error) return fail(toDataError(error));
  return data.length === 0 ? fail({ kind: "not-found" }) : ok(null);
}
