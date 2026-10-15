/**
 * Safety incident handlers (A14, RRR-26), spread into the shared Safety handler file: incidents
 * with their CAD lifecycle, parties, media, dispatch, medical encounters, crisis alerts, the global
 * emergency codes and the radio plan. Every call runs as the caller. Filing goes through
 * app.report_incident (reporter from the session), moves through app.transition_incident with
 * compare-and-set, and closing through app.close_incident, which records sign-off (invariant 22).
 * Medical treatment notes are written only through A03F's encrypting RPCs and read only through
 * app.medical_encounters_masked, so a caller without data.restricted.read.medical reads null.
 */
import {
  addMedicalEncounter,
  closeIncident,
  endCrisisAlert,
  reportIncident,
  transitionIncident,
  updateMedicalEncounter,
  type IncidentState,
} from "@xos/data/incidents";
import { refused } from "../../problem.ts";
import type { RequestContext } from "../../runtime/context.ts";
import { requireOrg } from "../../runtime/context.ts";
import { created, ok, type ErasedHandler } from "../../runtime/handler.ts";
import type { ListQuery } from "../../runtime/listing.ts";
import { from, run, tableResource, unwrap, type Row } from "../support/table.ts";

const incidents = tableResource("incidents");
const parties = tableResource("incidentParties");
const media = tableResource("incidentMediaItems");
const dispatch = tableResource("dispatchAssignments");
const alerts = tableResource("crisisAlerts");
const codes = tableResource("emergencyCodes", { softDelete: false });
const channels = tableResource("radioChannels");

/**
 * Medical encounters read their non-restricted columns from the table and the treatment notes
 * from the masked view, which answers null to a caller without the medical capability.
 */
async function withNotes(context: RequestContext, rows: readonly Row[]): Promise<Row[]> {
  const ids = rows.map((r) => r["id"]).filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return [...rows];
  const notes = await run<{ id: string; treatment_notes: string | null }[]>(
    from(context.db, "medical_encounters_masked").select("id, treatment_notes").in("id", ids),
  );
  const byId = new Map(notes.map((n) => [n.id, n.treatment_notes]));
  return rows.map((r) => ({ ...r, treatment_notes: byId.get(String(r["id"])) ?? null }));
}

const encounters = tableResource("medicalEncounters", {
  derived: ["treatment_notes"],
  toContract: async (row, context) => (await withNotes(context, [row]))[0] ?? row,
});

interface IncidentBody {
  readonly project_id: string;
  readonly title: string;
  readonly severity_enum_id: string;
  readonly occurred_at: string;
  readonly zone_id?: string | null;
  readonly latitude?: number | null;
  readonly longitude?: number | null;
  readonly accuracy_m?: number | null;
  readonly device_reported_at?: string | null;
}

interface TransitionBody {
  readonly expected_state: IncidentState;
  readonly to_state: IncidentState;
  readonly reason?: string;
}

export const incidentHandlers: Readonly<Record<string, ErasedHandler>> = {
  ...incidents.handlers,
  ...parties.handlers,
  ...media.handlers,
  ...dispatch.handlers,
  ...alerts.handlers,
  ...codes.handlers,
  ...channels.handlers,
  "medicalEncounters.list": async (request, context) =>
    ok(await encounters.list(context, request.query as ListQuery)),
  "medicalEncounters.get": async (request, context) =>
    ok(await encounters.read(context, String(request.params["id"]))),

  "incidents.create": async (request, context) => {
    const body = request.body as IncidentBody;
    const located =
      body.latitude !== undefined &&
      body.latitude !== null &&
      body.longitude !== undefined &&
      body.longitude !== null;
    const filed = unwrap(
      await reportIncident(context.db, {
        orgId: requireOrg(context).id,
        projectId: body.project_id,
        title: body.title,
        severityId: body.severity_enum_id,
        occurredAt: body.occurred_at,
        zoneId: body.zone_id ?? null,
        ...(located
          ? { latitude: body.latitude as number, longitude: body.longitude as number }
          : {}),
        ...(located && body.accuracy_m !== undefined && body.accuracy_m !== null
          ? { accuracyM: body.accuracy_m }
          : {}),
        ...(body.device_reported_at ? { deviceAt: body.device_reported_at } : {}),
      }),
    );
    return created(await incidents.read(context, filed.id));
  },

  "incidents.transition": async (request, context) => {
    const id = String(request.params["id"]);
    const body = request.body as TransitionBody;
    await incidents.read(context, id, ["id"]);
    unwrap(
      await transitionIncident(context.db, {
        id,
        expected: body.expected_state,
        // A move to Closed is refused by app.transition_incident (incident_close_rpc): closing
        // goes through POST /incidents/{id}/close, which records sign-off.
        next: body.to_state as Exclude<IncidentState, "Closed">,
        reason: body.reason ?? "",
      }),
    );
    return ok(await incidents.read(context, id));
  },

  "incidents.close": async (request, context) => {
    const id = String(request.params["id"]);
    await incidents.read(context, id, ["id"]);
    unwrap(await closeIncident(context.db, id, (request.body as { note: string }).note));
    return ok(await incidents.read(context, id));
  },

  "medicalEncounters.create": async (request, context) => {
    const body = request.body as {
      incident_id: string;
      patient_description: string;
      treatment_notes?: string | null;
      disposition?: string | null;
    };
    const result = unwrap(
      await addMedicalEncounter(context.db, {
        orgId: requireOrg(context).id,
        incidentId: body.incident_id,
        patientDescription: body.patient_description,
        treatmentNotes: body.treatment_notes ?? null,
        disposition: body.disposition ?? null,
      }),
    );
    return created(await encounters.read(context, result.id));
  },

  "medicalEncounters.update": async (request, context) => {
    const id = String(request.params["id"]);
    const body = request.body as {
      patient_description?: string;
      treatment_notes?: string | null;
      disposition?: string | null;
    };
    await encounters.read(context, id, ["id"]);
    unwrap(
      await updateMedicalEncounter(context.db, id, {
        ...(body.patient_description ? { patientDescription: body.patient_description } : {}),
        ...(body.treatment_notes ? { treatmentNotes: body.treatment_notes } : {}),
        ...(body.disposition ? { disposition: body.disposition } : {}),
      }),
    );
    return ok(await encounters.read(context, id));
  },

  "crisisAlerts.clear": async (request, context) => {
    const id = String(request.params["id"]);
    const current = await alerts.read(context, id, ["id", "ended_at"]);
    if (current["ended_at"] !== null) {
      throw refused("REFUSE", "This crisis alert has already ended.", "crisis_alert_ended");
    }
    unwrap(await endCrisisAlert(context.db, id));
    return ok(await alerts.read(context, id));
  },
};
