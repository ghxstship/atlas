import { toRecordSummary, type RecordSummary } from "../src/work.ts";

/** A records row as PostgREST returns it with the project and owner embedded. */
export function recordRow(over: Record<string, unknown> = {}) {
  return {
    id: "r1",
    project_id: "p1",
    record_number: 7,
    record_kind: "Task",
    record_subtype: "Execute",
    record_state: "Proposed",
    title: "Hang the truss",
    phase_code: "BLD",
    urid: null,
    xyz: "Y",
    owner_party_id: "pe1",
    accountable_party_id: null,
    scope_node_id: null,
    starts_at: null,
    ends_at: null,
    due_at: null,
    time_zone: null,
    blocker_text: null,
    replan_reason: null,
    created_at: "2027-05-01T00:00:00Z",
    updated_at: "2027-05-02T00:00:00Z",
    deleted_at: null,
    archived_at: null,
    project: { project_key: "NWL", name: "Northwind Summer Series", time_zone: "America/New_York" },
    owner: { full_name: "Dana Reyes" },
    ...over,
  };
}

/** The same row as a RecordSummary. */
export function summary(over: Record<string, unknown> = {}): RecordSummary {
  return toRecordSummary(recordRow(over));
}
