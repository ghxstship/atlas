/**
 * What Today's blocks for outside parties show (navigation.generated.ts lists the blocks per audience). Each picks the
 * rows of the current project that matter now, from the api_external views the REST downloader keeps on the device.
 * Pure, so each block's rule is tested without a device.
 */

export interface TodayItem {
  readonly id: string;
  readonly title: string;
  /** ISO start and end, shown in the project's zone; either may be absent. */
  readonly startsAt?: string | null;
  readonly endsAt?: string | null;
  /** A short second line: a gate, a supplier, a reference, a state. */
  readonly detail?: string | null;
  /** True when the item needs the person's attention: overdue, returned or canceled. */
  readonly flagged?: boolean;
  /** Vehicles a delivery window can still take. */
  readonly placesLeft?: number;
  /** How many of an entitlement the sponsor receives, when more than one. */
  readonly quantity?: number;
  /** A deliverable's state (Open or Returned), shown in the person's language. */
  readonly state?: string;
  /** An entitlement already fulfilled, or a briefing canceled. */
  readonly done?: boolean;
  readonly canceled?: boolean;
}

type Rows = readonly Readonly<Record<string, unknown>>[];

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const onProject = (rows: Rows, projectId: string) =>
  rows.filter((r) => r["project_id"] === projectId);
const notEnded = (now: number) => (r: Readonly<Record<string, unknown>>) => {
  const end = str(r["ends_at"]) ?? str(r["starts_at"]);
  return end === null || Date.parse(end) >= now;
};
const byStart = (a: Readonly<Record<string, unknown>>, b: Readonly<Record<string, unknown>>) =>
  (str(a["starts_at"]) ?? "").localeCompare(str(b["starts_at"]) ?? "");

/** Vendor: dock slots booked on the project that have not ended, soonest first. */
export function dockSlotItems(slots: Rows, projectId: string, now: number): TodayItem[] {
  return onProject(slots, projectId)
    .filter(notEnded(now))
    .sort(byStart)
    .map((s) => ({
      id: String(s["id"]),
      title: str(s["zone_name"]) ?? str(s["zone_code"]) ?? "",
      startsAt: str(s["starts_at"]),
      endsAt: str(s["ends_at"]),
      detail: str(s["reference_code"]),
    }));
}

/** Vendor: open load-in and load-out windows still to come, with the places left. */
export function deliveryWindowItems(windows: Rows, projectId: string, now: number): TodayItem[] {
  return onProject(windows, projectId)
    .filter(notEnded(now))
    .sort(byStart)
    .map((w) => ({
      id: String(w["id"]),
      title: str(w["zone_name"]) ?? str(w["zone_code"]) ?? "",
      startsAt: str(w["starts_at"]),
      endsAt: str(w["ends_at"]),
      ...(typeof w["places_left"] === "number" ? { placesLeft: w["places_left"] } : {}),
      flagged: w["places_left"] === 0,
    }));
}

/** Contractor: deliverables still to hand in or returned for changes, by due date; overdue ones flagged. */
export function deliverableItems(deliverables: Rows, now: number): TodayItem[] {
  return deliverables
    .filter((d) => d["deliverable_state"] === "Open" || d["deliverable_state"] === "Returned")
    .sort((a, b) => (str(a["due_at"]) ?? "9999").localeCompare(str(b["due_at"]) ?? "9999"))
    .map((d) => {
      const due = str(d["due_at"]);
      return {
        id: String(d["id"]),
        title: str(d["title"]) ?? "",
        endsAt: due,
        state: String(d["deliverable_state"]),
        flagged: d["deliverable_state"] === "Returned" || (due !== null && Date.parse(due) < now),
      };
    });
}

/** Contractor: the person's own credentials on the project that are valid now or later, with their hours. */
export function siteAccessItems(
  credentials: Rows,
  projectId: string,
  personId: string | null,
  now: number,
): TodayItem[] {
  return onProject(credentials, projectId)
    .filter((c) => personId === null || c["holder_person_id"] === personId)
    .filter(
      (c) =>
        !c["revoked_at"] &&
        (str(c["valid_to"]) === null || Date.parse(String(c["valid_to"])) >= now),
    )
    .sort((a, b) => (str(a["valid_from"]) ?? "").localeCompare(str(b["valid_from"]) ?? ""))
    .map((c) => ({
      id: String(c["id"]),
      title: str(c["category_name"]) ?? str(c["category_code"]) ?? "",
      startsAt: str(c["valid_from"]),
      endsAt: str(c["valid_to"]),
      detail: str(c["credential_number"]),
    }));
}

/** Outside crew: the project's briefings that have not ended; a canceled one stays, flagged, with its reason. */
export function briefingItems(briefings: Rows, projectId: string, now: number): TodayItem[] {
  return onProject(briefings, projectId)
    .filter(notEnded(now))
    .sort(byStart)
    .map((b) => ({
      id: String(b["id"]),
      title: str(b["title"]) ?? "",
      startsAt: str(b["starts_at"]),
      endsAt: str(b["ends_at"]),
      detail: b["canceled_at"] ? str(b["cancel_reason"]) : str(b["location"]),
      flagged: Boolean(b["canceled_at"]),
      canceled: Boolean(b["canceled_at"]),
    }));
}

/** Artist party: hospitality on the project for the artist or their whole party, still to come. */
export function hospitalityItems(lines: Rows, projectId: string, now: number): TodayItem[] {
  return onProject(lines, projectId)
    .filter(notEnded(now))
    .sort(byStart)
    .map((h) => ({
      id: String(h["id"]),
      title: [str(h["title"]), str(h["description"])].filter((x) => x !== null).join(": "),
      startsAt: str(h["starts_at"]),
      endsAt: str(h["ends_at"]),
      detail: str(h["supplier_name"]),
    }));
}

/** Client: approvals the project is waiting on from the client, oldest first. */
export function approvalItems(approvals: Rows, projectId: string): TodayItem[] {
  return onProject(approvals, projectId)
    .filter((a) => a["decision"] === null || a["decision"] === undefined)
    .sort((a, b) => (str(a["requested_at"]) ?? "").localeCompare(str(b["requested_at"]) ?? ""))
    .map((a) => ({
      id: String(a["id"]),
      title: str(a["message"]) ?? str(a["subject_kind"]) ?? "",
      startsAt: str(a["requested_at"]),
      detail: str(a["subject_kind"]),
    }));
}

/** Sponsor: the activation's space bookings still to come. */
export function activationItems(bookings: Rows, projectId: string, now: number): TodayItem[] {
  return onProject(bookings, projectId)
    .filter(notEnded(now))
    .sort(byStart)
    .map((b) => ({
      id: String(b["id"]),
      title: str(b["space_name"]) ?? "",
      startsAt: str(b["starts_at"]),
      endsAt: str(b["ends_at"]),
      detail: str(b["purpose"]) ?? str(b["set_label"]),
    }));
}

/** Sponsor: every entitlement on the project, open ones first by due date; overdue ones flagged. */
export function entitlementItems(entitlements: Rows, projectId: string): TodayItem[] {
  return onProject(entitlements, projectId)
    .sort((a, b) => {
      const done = Number(Boolean(a["fulfilled_at"])) - Number(Boolean(b["fulfilled_at"]));
      return done !== 0
        ? done
        : (str(a["due_on"]) ?? "9999").localeCompare(str(b["due_on"]) ?? "9999");
    })
    .map((e) => ({
      id: String(e["id"]),
      title: str(e["description"]) ?? "",
      ...(typeof e["quantity"] === "number" && e["quantity"] > 1
        ? { quantity: e["quantity"] }
        : {}),
      endsAt: str(e["due_on"]),
      done: Boolean(e["fulfilled_at"]),
      flagged: e["is_overdue"] === true,
    }));
}
