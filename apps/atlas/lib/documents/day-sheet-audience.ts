import { cueCallKindOf } from "@xos/data/cue-calls";
import type { LoadOptions } from "@xos/data/documents/sources";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPARTMENT = /^[0-9]000$/;

/**
 * A day sheet's audience from the document route's query string (B7, ADR 0146 decision 3): `team` (a uuid) or
 * `department` (a canon code, X000), and `dept` (a show department slug, CUE_CALL_SLUGS). Null for none; "bad" for
 * both a team and a department, or a malformed value, which the route answers 400.
 */
export function daySheetAudience(search: URLSearchParams): LoadOptions["audience"] | "bad" {
  const team = search.get("team");
  const department = search.get("department");
  const dept = search.get("dept");
  if (team !== null && department !== null) return "bad";
  if (team !== null && !UUID.test(team)) return "bad";
  if (department !== null && !DEPARTMENT.test(department)) return "bad";
  const showDepartment = dept === null ? null : cueCallKindOf(dept);
  if (dept !== null && showDepartment === null) return "bad";
  if (team === null && department === null && showDepartment === null) return null;
  return {
    teamId: team?.toLowerCase() ?? null,
    departmentCode: department,
    showDepartment,
  };
}
