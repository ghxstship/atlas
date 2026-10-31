import type { XosClient } from "./client.ts";
import { fail, ok, toDataError, type Result } from "./result.ts";
import { resolveSettings } from "./settings.ts";
import { untyped } from "./untyped.ts";
import { settingInteger } from "./workload.ts";

/**
 * Scheduling clashes (B4, G-46 and G-47, migration 2936, ADR 0143 decisions 5 and 6): app.schedule_clashes returns
 * candidate facts as the caller sees them, and classifyClash applies the org's thresholds and decides each one's
 * severity. Nothing is stored and nothing is fixed automatically: each clash links to where a planner fixes it. R5's
 * requested travel is checked only by loadTravelRequestClashes, which the database logs in each person's access log;
 * its rows are never cached, listed with the other clashes or exported.
 */

export const CHANGEOVER_MINUTES_KEY = "scheduling.changeover_minutes";
export const TRAVEL_BUFFER_MINUTES_KEY = "scheduling.travel_buffer_minutes";
export const CHANGEOVER_MINUTES_DEFAULT = 15;
export const TRAVEL_BUFFER_MINUTES_DEFAULT = 120;

export type ClashRule =
  | "person_double_booked"
  | "person_in_transit"
  | "supplier_overlap"
  | "supplier_dock_overlap"
  | "set_two_stages"
  | "changeover"
  | "arrival_near_call"
  | "departure_near_call_end"
  | "past_curfew";

export const CLASH_RULES: readonly ClashRule[] = [
  "person_double_booked",
  "person_in_transit",
  "supplier_overlap",
  "supplier_dock_overlap",
  "set_two_stages",
  "changeover",
  "arrival_near_call",
  "departure_near_call_end",
  "past_curfew",
];

export type ClashSeverity = "Clash" | "Warning";

/** A candidate fact as app.schedule_clashes returns it. */
export interface ClashCandidate {
  readonly rule: ClashRule;
  readonly projectId: string;
  readonly otherProjectId: string | null;
  readonly day: string;
  readonly subjectTable: string;
  readonly subjectId: string;
  readonly otherTable: string | null;
  readonly otherId: string | null;
  readonly partyKind: "person" | "counterparty" | null;
  readonly partyId: string | null;
  readonly partyName: string | null;
  readonly otherPartyName: string | null;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly otherStartsAt: string | null;
  readonly otherEndsAt: string | null;
  readonly gapMinutes: number | null;
  readonly tbc: boolean;
  readonly draft: boolean;
}

export interface ClashThresholds {
  readonly changeoverMinutes: number;
  readonly travelBufferMinutes: number;
}

export interface ClashLink {
  /** What the link opens: a shift peek, a running order, a travel segment, an engagement or a dock slot. */
  readonly kind: "shift" | "run_of_show" | "travel_segment" | "engagement" | "dock_slot" | "cue";
  readonly table: string;
  readonly id: string;
}

export interface Clash {
  readonly rule: ClashRule;
  readonly severity: ClashSeverity;
  /** The values the UI composes the sentence from, in both locales. */
  readonly params: {
    readonly party: string | null;
    readonly other: string | null;
    readonly startsAt: string | null;
    readonly endsAt: string | null;
    readonly otherStartsAt: string | null;
    readonly otherEndsAt: string | null;
    readonly gap: number | null;
    readonly minimum: number | null;
    readonly buffer: number | null;
    readonly tbc: boolean;
    readonly draft: boolean;
  };
  readonly links: readonly ClashLink[];
  readonly candidate: ClashCandidate;
}

const LINK_KINDS: Readonly<Record<string, ClashLink["kind"]>> = {
  shifts: "shift",
  run_of_show: "run_of_show",
  travel_segments: "travel_segment",
  engagements: "engagement",
  dock_slots: "dock_slot",
  cues: "cue",
};

function linksOf(c: ClashCandidate): ClashLink[] {
  const links: ClashLink[] = [];
  const add = (table: string | null, id: string | null) => {
    if (!table || !id) return;
    const kind = LINK_KINDS[table];
    if (kind) links.push({ kind, table, id });
  };
  add(c.subjectTable, c.subjectId);
  add(c.otherTable, c.otherId);
  return links;
}

/**
 * The severity of a candidate under the org's thresholds, or null when the rule drops it (ADR 0143, correction 27):
 *   person_double_booked     Clash, a Warning while either shift is Draft;
 *   person_in_transit        Clash;
 *   supplier_overlap         Warning;
 *   supplier_dock_overlap    Warning;
 *   set_two_stages           Clash;
 *   changeover               a Clash below 0 (the sets overlap), a Warning under the minimum, else dropped;
 *   arrival_near_call,
 *   departure_near_call_end  a Clash below 0, a Warning under the travel buffer, else dropped;
 *   past_curfew              Clash.
 * A TBC input lowers any of them to at most a Warning.
 */
export function classifyClash(
  candidate: ClashCandidate,
  thresholds: ClashThresholds,
): Clash | null {
  const gap = candidate.gapMinutes;
  let severity: ClashSeverity | null;
  switch (candidate.rule) {
    case "person_double_booked":
      severity = candidate.draft ? "Warning" : "Clash";
      break;
    case "person_in_transit":
    case "set_two_stages":
    case "past_curfew":
      severity = "Clash";
      break;
    case "supplier_overlap":
    case "supplier_dock_overlap":
      severity = "Warning";
      break;
    case "changeover":
      severity =
        gap === null
          ? null
          : gap < 0
            ? "Clash"
            : gap < thresholds.changeoverMinutes
              ? "Warning"
              : null;
      break;
    case "arrival_near_call":
    case "departure_near_call_end":
      severity =
        gap === null
          ? null
          : gap < 0
            ? "Clash"
            : gap < thresholds.travelBufferMinutes
              ? "Warning"
              : null;
      break;
    default:
      severity = null;
  }
  if (severity === null) return null;
  if (candidate.tbc) severity = "Warning";
  return {
    rule: candidate.rule,
    severity,
    params: {
      party: candidate.partyName,
      other: candidate.otherPartyName,
      startsAt: candidate.startsAt,
      endsAt: candidate.endsAt,
      otherStartsAt: candidate.otherStartsAt,
      otherEndsAt: candidate.otherEndsAt,
      gap,
      minimum: candidate.rule === "changeover" ? thresholds.changeoverMinutes : null,
      buffer:
        candidate.rule === "arrival_near_call" || candidate.rule === "departure_near_call_end"
          ? thresholds.travelBufferMinutes
          : null,
      tbc: candidate.tbc,
      draft: candidate.draft,
    },
    links: linksOf(candidate),
    candidate,
  };
}

interface ClashRow {
  rule: ClashRule;
  project_id: string;
  other_project_id: string | null;
  day: string;
  subject_table: string;
  subject_id: string;
  other_table: string | null;
  other_id: string | null;
  party_kind: "person" | "counterparty" | null;
  party_id: string | null;
  party_name: string | null;
  other_party_name: string | null;
  starts_at: string | null;
  ends_at: string | null;
  other_starts_at: string | null;
  other_ends_at: string | null;
  gap_minutes: number | null;
  tbc: boolean;
  draft: boolean;
}

export function toCandidate(r: ClashRow): ClashCandidate {
  return {
    rule: r.rule,
    projectId: r.project_id,
    otherProjectId: r.other_project_id,
    day: r.day,
    subjectTable: r.subject_table,
    subjectId: r.subject_id,
    otherTable: r.other_table,
    otherId: r.other_id,
    partyKind: r.party_kind,
    partyId: r.party_id,
    partyName: r.party_name,
    otherPartyName: r.other_party_name,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    otherStartsAt: r.other_starts_at,
    otherEndsAt: r.other_ends_at,
    gapMinutes: r.gap_minutes,
    tbc: r.tbc,
    draft: r.draft,
  };
}

/** The org's thresholds from its resolved settings. */
export function clashThresholds(
  settings: ReadonlyMap<string, { readonly value: unknown }>,
): ClashThresholds {
  return {
    changeoverMinutes: settingInteger(settings, CHANGEOVER_MINUTES_KEY, CHANGEOVER_MINUTES_DEFAULT),
    travelBufferMinutes: settingInteger(
      settings,
      TRAVEL_BUFFER_MINUTES_KEY,
      TRAVEL_BUFFER_MINUTES_DEFAULT,
    ),
  };
}

/** The clashes the caller can see over 1 to 92 days, classified under the org's thresholds, Clashes first. */
export async function loadClashes(
  db: XosClient,
  input: {
    readonly orgId: string;
    readonly from: string;
    readonly to: string;
    readonly projectId?: string | null;
  },
): Promise<Result<{ clashes: Clash[]; thresholds: ClashThresholds }>> {
  const [rows, settings] = await Promise.all([
    untyped(db).rpc("schedule_clashes", {
      p_org_id: input.orgId,
      p_from: input.from,
      p_to: input.to,
      p_project_id: input.projectId ?? null,
    }),
    resolveSettings(db, { orgId: input.orgId }),
  ]);
  if (rows.error) return fail(toDataError(rows.error));
  const thresholds = settings.ok
    ? clashThresholds(settings.data)
    : {
        changeoverMinutes: CHANGEOVER_MINUTES_DEFAULT,
        travelBufferMinutes: TRAVEL_BUFFER_MINUTES_DEFAULT,
      };
  const clashes = (rows.data as ClashRow[])
    .map((r) => classifyClash(toCandidate(r), thresholds))
    .filter((c): c is Clash => c !== null)
    .sort(
      (a, b) =>
        (a.severity === b.severity ? 0 : a.severity === "Clash" ? -1 : 1) ||
        a.candidate.day.localeCompare(b.candidate.day) ||
        a.rule.localeCompare(b.rule),
    );
  return ok({ clashes, thresholds });
}

/** Clash counts per project, for the portfolio timeline's tags. A clash counts on both of its projects. */
export function clashCountsByProject(clashes: readonly Clash[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of clashes) {
    const ids = new Set(
      [c.candidate.projectId, c.candidate.otherProjectId].filter((x): x is string => !!x),
    );
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

export type TravelRequestRule = "requested_arrival_after_call" | "requested_departure_before_call";

export interface TravelRequestClash {
  readonly rule: TravelRequestRule;
  readonly personId: string;
  readonly personName: string | null;
  readonly rosterEntryId: string;
  readonly requestedOn: string;
  readonly callDay: string;
  readonly callTable: "shifts" | "cues";
  readonly callId: string;
}

interface TravelRow {
  rule: TravelRequestRule;
  person_id: string;
  person_name: string | null;
  roster_entry_id: string;
  requested_on: string;
  call_day: string;
  call_table: "shifts" | "cues";
  call_id: string;
}

/**
 * R5's requested travel dates against each person's calls (hospitality.fulfillment.read; the database logs a
 * project_facts.viewed row for each person returned and counts the rest). Never cache the result.
 */
export async function loadTravelRequestClashes(
  db: XosClient,
  projectId: string,
): Promise<Result<TravelRequestClash[]>> {
  const { data, error } = await untyped(db).rpc("travel_request_clashes", {
    p_project_id: projectId,
  });
  if (error) return fail(toDataError(error));
  return ok(
    (data as TravelRow[]).map((r) => ({
      rule: r.rule,
      personId: r.person_id,
      personName: r.person_name,
      rosterEntryId: r.roster_entry_id,
      requestedOn: r.requested_on,
      callDay: r.call_day,
      callTable: r.call_table,
      callId: r.call_id,
    })),
  );
}
