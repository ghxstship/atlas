/**
 * Native More screens for external role types (Section 4.5.7 role table, A65-011 part 2, A92): timesheets, per diem,
 * travel and lodging and onboarding for crew and staff; purchase orders, deliveries and submittals for vendors; time
 * entries and deliverables for contractors; the advance summary, rider and settlement for artists and their
 * representatives; reports for clients; proof of performance for sponsors. Each reads the api_external projections
 * Compass downloads (src/data/sources.ts), so it works offline, and keeps the actions that change records on the
 * engagement in Gateway, one tap away.
 *
 * Everything here is pure: a page turns local rows into sections of items whose dates name the calendar they belong
 * on (src/domain/dates.ts). Calendar dates stay as written; instants carry the zone of their project, or of their own
 * place for travel, or none, which the screen shows in the person's own zone. "Today" is today on the project's
 * calendar, as Gateway's engagement view uses it (A71).
 */
import type { Audience, Row } from "@xos/sync";
import type { EngagementSummary } from "./access";
import { buildItinerary } from "@xos/data/itinerary";
import { dayIn, daysUntil } from "./dates";

export type ExternalPageId =
  | "timesheets"
  | "per-diem"
  | "travel-and-lodging"
  | "onboarding"
  | "purchase-orders"
  | "deliveries"
  | "submittals"
  | "time-entries"
  | "deliverables"
  | "advance-summary"
  | "rider"
  | "settlement"
  | "reports"
  | "proof-of-performance";

/** One fact on an item, formatted by the screen in the person's language. */
export type Fact =
  | { readonly kind: "day"; readonly day: string }
  | { readonly kind: "range"; readonly from: string; readonly to: string | null }
  | { readonly kind: "instant"; readonly at: string; readonly zone: string | null }
  | { readonly kind: "money"; readonly minor: number; readonly currency: string }
  | { readonly kind: "minutes"; readonly minutes: number }
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "label";
      readonly key: string;
      readonly values?: Readonly<Record<string, string | number>>;
    };

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

export interface ExternalItem {
  readonly id: string;
  readonly icon: string;
  /** Empty when the first fact names the item (a time entry is its clock-in time). */
  readonly title: string;
  readonly facts: readonly Fact[];
  /** A catalog key for the state, with its tone. */
  readonly tag?: { readonly key: string; readonly tone: Tone } | undefined;
  /** Lines under the item: purchase order lines, rider asks, settlement lines, advance sections. */
  readonly lines?: readonly ExternalItem[];
  /** Changed or new since the person last looked (B6, the itinerary): the screen shows a chip naming the fields. */
  readonly changed?: {
    readonly kind: "added" | "changed" | "removed";
    readonly fields: readonly string[];
  };
}

export interface ExternalSection {
  readonly id: string;
  /** Catalog key of the section heading. */
  readonly titleKey: string;
  readonly items: readonly ExternalItem[];
  /** Done of total, shown as a progress bar (onboarding). */
  readonly progress?: { readonly done: number; readonly total: number };
  /** The calendar date a day section of the itinerary is for, `YYYY-MM-DD`; its heading names it. */
  readonly day?: string;
}

export interface PageInput {
  /** Local rows of a downloaded table. */
  readonly rows: (table: string) => readonly Row[];
  readonly projectId: string | null;
  readonly personId: string;
  readonly engagements: readonly EngagementSummary[];
  /** The project's time zone (api_external.projects), or null when unknown. */
  readonly zoneOf: (projectId: string | null | undefined) => string | null;
  /** Today on a project's calendar, YYYY-MM-DD. */
  readonly todayOf: (projectId: string | null | undefined) => string;
  /**
   * The itinerary baseline the screen's last online visit returned (app.record_visit): changes at or before it were
   * seen and show no chip. Absent offline, when the downloaded marks stay as they are.
   */
  readonly seenBaseline?: string | null;
}

export interface ExternalPage {
  readonly id: ExternalPageId;
  readonly audiences: readonly Audience[];
  /** Local tables the page reads, which the refresh pulls. */
  readonly tables: readonly string[];
  /** The Gateway engagement tab where its actions live (apps/gateway/ia/sitemap.yaml). */
  readonly gatewayTab: string;
  readonly icon: string;
  /** Catalog key of the sentence for an empty page. */
  readonly emptyKey: string;
  readonly build: (input: PageInput) => readonly ExternalSection[];
}

// Row access ---------------------------------------------------------------------------------------------------

const str = (row: Row, key: string): string | null => {
  const v = row[key];
  return typeof v === "string" && v.length > 0 ? v : null;
};
const num = (row: Row, key: string): number | null => {
  const v = row[key];
  const n =
    typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const bool = (row: Row, key: string): boolean => row[key] === true;

/** The catalog key of a stored enum value, as Gateway keys them (`Ready for Review` becomes `readyForReview`). */
export function enumKey(value: string): string {
  return value
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) =>
      i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join("");
}

/** A state tag from Gateway's enum labels (gateway.enums.<enum>.<value>), which both shells share. */
function stateTag(enumName: string, value: string | null, tones: Readonly<Record<string, Tone>>) {
  if (!value) return undefined;
  return { key: `gateway.enums.${enumName}.${enumKey(value)}`, tone: tones[value] ?? "neutral" };
}

/** The project an engagement-keyed row belongs to, through the person's engagements. */
function engagementProject(input: PageInput, engagementId: string | null): string | null {
  return input.engagements.find((e) => e.id === engagementId)?.projectId ?? null;
}

/** Rows of the current project: by their project, or by their engagement's project. */
function onProject(input: PageInput, table: string): Row[] {
  return input.rows(table).filter((r) => {
    const project = str(r, "project_id") ?? engagementProject(input, str(r, "engagement_id"));
    return input.projectId === null || project === input.projectId;
  });
}

const byKey =
  (key: string, direction: 1 | -1 = 1) =>
  (a: Row, b: Row) =>
    direction * String(a[key] ?? "").localeCompare(String(b[key] ?? ""));

function section(
  id: string,
  titleKey: string,
  items: readonly ExternalItem[],
  progress?: ExternalSection["progress"],
) {
  return items.length > 0 ? [{ id, titleKey, items, ...(progress ? { progress } : {}) }] : [];
}

// Crew and staff -------------------------------------------------------------------------------------------------

const TIMESHEET_TONES: Readonly<Record<string, Tone>> = {
  Proposed: "accent",
  Submitted: "neutral",
  Approved: "success",
  Rejected: "danger",
};

function timesheets(input: PageInput): ExternalSection[] {
  const items = onProject(input, "timesheets")
    .sort(byKey("period_start", -1))
    .map((r): ExternalItem => {
      const start = str(r, "period_start") ?? "";
      const minutes = num(r, "worked_minutes");
      const decided = str(r, "decided_at");
      const submitted = str(r, "submitted_at");
      const zone = input.zoneOf(str(r, "project_id"));
      return {
        id: r.id,
        icon: "clock",
        title: str(r, "project_name") ?? "",
        facts: [
          { kind: "range", from: start, to: str(r, "period_end") },
          ...(minutes !== null ? [{ kind: "minutes", minutes } as const] : []),
          ...(decided
            ? [
                { kind: "label", key: "compassExternal.timesheets.decided" } as const,
                { kind: "instant", at: decided, zone } as const,
              ]
            : submitted
              ? [
                  { kind: "label", key: "compassExternal.timesheets.submitted" } as const,
                  { kind: "instant", at: submitted, zone } as const,
                ]
              : []),
        ],
        tag: stateTag("timesheetState", str(r, "timesheet_state"), TIMESHEET_TONES),
      };
    });
  return section("timesheets", "compassExternal.timesheets.title", items);
}

function perDiem(input: PageInput): ExternalSection[] {
  const rows = onProject(input, "per_diems").sort(byKey("day"));
  const items = rows.map((r): ExternalItem => {
    const day = str(r, "day") ?? "";
    const today = input.todayOf(str(r, "project_id"));
    const when = daysUntil(day, today);
    return {
      id: r.id,
      icon: "banknote",
      title: str(r, "project_name") ?? "",
      facts: [
        { kind: "day", day },
        {
          kind: "money",
          minor: num(r, "amount_minor") ?? 0,
          currency: str(r, "currency_code") ?? "USD",
        },
      ],
      ...(when === 0 ? { tag: { key: "compassExternal.today", tone: "accent" as const } } : {}),
    };
  });
  // The total per currency, so a week of per diem reads at a glance.
  const totals = new Map<string, number>();
  for (const r of rows) {
    const currency = str(r, "currency_code") ?? "USD";
    totals.set(currency, (totals.get(currency) ?? 0) + (num(r, "amount_minor") ?? 0));
  }
  const total: ExternalItem[] =
    rows.length > 0
      ? [
          {
            id: "per-diem-total",
            icon: "banknote",
            title: "",
            facts: [
              {
                kind: "label",
                key: "compassExternal.perDiem.total",
                values: { days: rows.length },
              },
              ...[...totals].map(
                ([currency, minor]) => ({ kind: "money", minor, currency }) as const,
              ),
            ],
          },
        ]
      : [];
  return [
    ...section("per-diem-total", "compassExternal.perDiem.totalTitle", total),
    ...section("per-diem", "compassExternal.perDiem.title", items),
  ];
}

/** A travel segment as one item: the route, the operator and each end in its own zone. */
function travelItem(r: Row, projectZone: string | null): ExternalItem {
  const departs = str(r, "departs_at");
  const arrives = str(r, "arrives_at");
  const service = [str(r, "operator_name"), str(r, "service_identifier")].filter(Boolean).join(" ");
  const route = [str(r, "departs_from"), str(r, "arrives_at_place")].filter(Boolean);
  const confirmation = str(r, "confirmation_identifier");
  return {
    id: r.id,
    icon: str(r, "travel_mode") === "Flight" ? "plane" : "truck",
    title: route.length === 2 ? `${route[0]} → ${route[1]}` : (route[0] ?? service),
    facts: [
      ...(service ? [{ kind: "text", text: service } as const] : []),
      // Each end in its own zone: a 9:00 departure from Miami reads 9:00, wherever the phone is.
      ...(departs
        ? [
            { kind: "label", key: "compassExternal.travel.departs" } as const,
            {
              kind: "instant",
              at: departs,
              zone: str(r, "departs_time_zone") ?? projectZone,
            } as const,
          ]
        : []),
      ...(arrives
        ? [
            { kind: "label", key: "compassExternal.travel.arrives" } as const,
            {
              kind: "instant",
              at: arrives,
              zone: str(r, "arrives_time_zone") ?? projectZone,
            } as const,
          ]
        : []),
      ...(confirmation
        ? [
            {
              kind: "label",
              key: "compassExternal.travel.confirmation",
              values: { code: confirmation },
            } as const,
          ]
        : []),
    ],
    tag: stateTag("travelMode", str(r, "travel_mode"), {}),
  };
}

const asText = (value: unknown): string | null => (typeof value === "string" ? value : null);

/**
 * Travel and lodging as a whole-stay itinerary (B6, G-65): the person's segments, check-ins and check-outs grouped by
 * day (packages/data itinerary.ts, as Gateway builds it), each marked when it changed since they last looked
 * (api_external.itinerary_changes, downloaded, so the marks read offline), and what was removed. A change at or before
 * the baseline the screen's last visit returned is hidden: it was seen.
 */
function travelAndLodging(input: PageInput): ExternalSection[] {
  const projectZone = input.zoneOf(input.projectId);
  const travelRows = onProject(input, "travel_segments");
  const lodgingRows = onProject(input, "lodging").filter(
    (r) => str(r, "person_id") === input.personId,
  );
  const itinerary = buildItinerary({
    travel: travelRows.map((r) => ({
      id: r.id,
      travel_mode: str(r, "travel_mode") ?? "Flight",
      operator_name: str(r, "operator_name"),
      service_identifier: str(r, "service_identifier"),
      departs_from: str(r, "departs_from") ?? "",
      departs_at: str(r, "departs_at") ?? "",
      departs_time_zone: str(r, "departs_time_zone") ?? projectZone ?? "UTC",
      arrives_at_place: str(r, "arrives_at_place") ?? "",
      arrives_at: str(r, "arrives_at"),
      arrives_time_zone: str(r, "arrives_time_zone") ?? projectZone ?? "UTC",
    })),
    lodging: lodgingRows.map((r) => ({
      id: r.id,
      hotel_name: str(r, "hotel_name"),
      block_title: str(r, "block_title"),
      check_in_on: str(r, "check_in_on") ?? "",
      check_out_on: str(r, "check_out_on") ?? "",
    })),
    changes: onProject(input, "itinerary_changes").map((r) => ({
      subject_kind: str(r, "subject_kind"),
      subject_id: str(r, "subject_id"),
      change_kind: str(r, "change_kind"),
      changed_fields: Array.isArray(r["changed_fields"])
        ? (r["changed_fields"] as unknown[]).map(asText).filter((f): f is string => f !== null)
        : [],
      changed_at: str(r, "changed_at"),
      baseline_at: str(r, "baseline_at"),
      title: str(r, "title"),
    })),
    projectZone,
    hideAtOrBefore: input.seenBaseline ?? null,
  });
  const travelById = new Map(travelRows.map((r) => [r.id, r]));
  const days = itinerary.days.map((day): ExternalSection => ({
    id: `day-${day.date}`,
    titleKey: "compassExternal.itinerary.day",
    day: day.date,
    items: day.items.map((item): ExternalItem => {
      const changed = item.changed ? { changed: item.changed } : {};
      if (item.type === "travel") {
        const row = travelById.get(item.id);
        return {
          ...(row
            ? travelItem(row, projectZone)
            : { id: item.id, icon: "plane", title: "", facts: [] }),
          ...changed,
        };
      }
      if (item.type === "set") {
        return {
          id: `set-${item.id}`,
          icon: "clock",
          title: item.set.label,
          facts: [{ kind: "instant", at: item.at, zone: projectZone }],
          ...changed,
        };
      }
      const hotel = item.lodging.hotel_name ?? item.lodging.block_title ?? "";
      return {
        id: `${item.type}-${item.id}`,
        icon: item.type === "check-in" ? "bed-double" : "log-out",
        title: hotel,
        facts: [
          {
            kind: "label",
            key:
              item.type === "check-in"
                ? "compassExternal.itinerary.checkIn"
                : "compassExternal.itinerary.checkOut",
          },
          ...(item.lodging.hotel_name && item.lodging.block_title
            ? [{ kind: "text", text: item.lodging.block_title } as const]
            : []),
        ],
        ...changed,
      };
    }),
  }));
  const removed = itinerary.removed.map((r): ExternalItem => ({
    id: `removed-${r.id}`,
    icon: "circle-x",
    title: r.title ?? "",
    facts: [
      {
        kind: "label",
        key: `compassExternal.itinerary.removedKind.${r.kind === "set_time" ? "set" : r.kind}`,
      },
    ],
  }));
  return [...days, ...section("removed", "compassExternal.itinerary.removedTitle", removed)];
}

/** Where an onboarding item stands on the project's calendar, as Gateway's checklist reads it. */
export function onboardingStanding(
  row: Row,
  today: string,
): "verified" | "expired" | "waiting" | "returned" | "to-do" {
  const expires = str(row, "expires_on");
  if (bool(row, "satisfied") || bool(row, "passes")) {
    return expires && expires < today ? "expired" : "verified";
  }
  const outcome = str(row, "latest_outcome");
  if (outcome && outcome !== "Pass" && outcome !== "Passed") return "returned";
  return str(row, "submitted_at") ? "waiting" : "to-do";
}

const STANDING_TONES: Readonly<Record<string, Tone>> = {
  verified: "success",
  expired: "danger",
  waiting: "neutral",
  returned: "warning",
  "to-do": "accent",
};

function onboarding(input: PageInput): ExternalSection[] {
  const rows = onProject(input, "onboarding_items");
  const items = rows
    .map((r) => {
      const today = input.todayOf(engagementProject(input, str(r, "engagement_id")));
      return { row: r, standing: onboardingStanding(r, today) };
    })
    // What is left to do first, then what waits on the org, then what is done.
    .sort(
      (a, b) =>
        ["to-do", "returned", "expired", "waiting", "verified"].indexOf(a.standing) -
          ["to-do", "returned", "expired", "waiting", "verified"].indexOf(b.standing) ||
        String(a.row["name"] ?? "").localeCompare(String(b.row["name"] ?? "")),
    )
    .map(({ row: r, standing }): ExternalItem => {
      const expires = str(r, "expires_on");
      const kind = str(r, "item_kind");
      return {
        id: r.id,
        icon: standing === "verified" ? "check" : "list-checks",
        title: str(r, "name") ?? "",
        facts: [
          ...(kind
            ? [{ kind: "label", key: `gateway.enums.onboardingItemKind.${enumKey(kind)}` } as const]
            : []),
          ...(bool(r, "is_blocking")
            ? [{ kind: "label", key: "compassExternal.onboarding.blocking" } as const]
            : []),
          ...(expires
            ? [
                { kind: "label", key: "compassExternal.onboarding.expires" } as const,
                { kind: "day", day: expires } as const,
              ]
            : []),
        ],
        tag: {
          key: `compassExternal.onboarding.standing.${enumKey(standing)}`,
          tone: STANDING_TONES[standing] ?? "neutral",
        },
      };
    });
  const done = items.filter((i) => i.tag?.key.endsWith(".verified")).length;
  return section("onboarding", "compassExternal.onboarding.title", items, {
    done,
    total: items.length,
  });
}

// Vendors ----------------------------------------------------------------------------------------------------------

const PO_TONES: Readonly<Record<string, Tone>> = {
  Sent: "accent",
  Closed: "success",
  Canceled: "neutral",
};

function purchaseOrders(input: PageInput): ExternalSection[] {
  const lines = input.rows("po_lines");
  const items = onProject(input, "purchase_orders")
    .sort(byKey("sent_at", -1))
    .map((r): ExternalItem => {
      const currency = str(r, "currency_code") ?? "USD";
      const total = num(r, "total_minor");
      const sent = str(r, "sent_at");
      const acknowledged = str(r, "acknowledged_at");
      const zone = input.zoneOf(str(r, "project_id"));
      return {
        id: r.id,
        icon: "file-text",
        title: `PO ${num(r, "po_number") ?? ""} · ${str(r, "org_name") ?? ""}`.trim(),
        facts: [
          ...(total !== null
            ? [{ kind: "money", minor: total, currency } as const]
            : [{ kind: "label", key: "compassExternal.purchaseOrders.unpriced" } as const]),
          ...(sent
            ? [
                { kind: "label", key: "compassExternal.purchaseOrders.sent" } as const,
                { kind: "instant", at: sent, zone } as const,
              ]
            : []),
          {
            kind: "label",
            key: acknowledged
              ? "compassExternal.purchaseOrders.acknowledged"
              : "compassExternal.purchaseOrders.notAcknowledged",
          },
        ],
        tag: stateTag("poState", str(r, "po_state"), PO_TONES),
        lines: lines
          .filter((l) => str(l, "purchase_order_id") === r.id)
          .sort((a, b) => (num(a, "line_number") ?? 0) - (num(b, "line_number") ?? 0))
          .map((l): ExternalItem => ({
            id: l.id,
            icon: "list",
            title: `${num(l, "line_number") ?? ""}. ${str(l, "description") ?? ""}`,
            facts: [
              {
                kind: "label",
                key: "compassExternal.quantity",
                values: { quantity: num(l, "quantity") ?? 0, unit: str(l, "unit_basis") ?? "" },
              },
              ...(num(l, "amount_minor") !== null
                ? [{ kind: "money", minor: num(l, "amount_minor") ?? 0, currency } as const]
                : []),
            ],
          })),
      };
    });
  return section("purchase-orders", "compassExternal.purchaseOrders.title", items);
}

function deliveries(input: PageInput): ExternalSection[] {
  const items = onProject(input, "deliveries")
    .sort(byKey("arrives_at"))
    .map((r): ExternalItem => {
      const zone = input.zoneOf(str(r, "project_id"));
      const ships = str(r, "ships_at");
      const arrives = str(r, "arrives_at");
      return {
        id: r.id,
        icon: "truck",
        title: str(r, "tracking_identifier") ?? str(r, "project_name") ?? "",
        facts: [
          ...(ships
            ? [
                { kind: "label", key: "compassExternal.deliveries.ships" } as const,
                { kind: "instant", at: ships, zone } as const,
              ]
            : []),
          ...(arrives
            ? [
                { kind: "label", key: "compassExternal.deliveries.arrives" } as const,
                { kind: "instant", at: arrives, zone } as const,
              ]
            : []),
        ],
        tag: stateTag("shipmentDirection", str(r, "direction"), {}),
      };
    });
  return section("deliveries", "compassExternal.deliveries.title", items);
}

/** Record kinds the org shares with a vendor for review, which is where submittal requests arrive (Gateway). */
export const SUBMITTAL_KINDS: readonly string[] = ["Approval", "Document", "Compliance"];

function submittals(input: PageInput): ExternalSection[] {
  const items = onProject(input, "shared_records")
    .filter((r) => SUBMITTAL_KINDS.includes(str(r, "record_kind") ?? ""))
    .sort(byKey("due_at"))
    .map((r): ExternalItem => {
      const due = str(r, "due_at");
      return {
        id: r.id,
        icon: "file-check",
        title: str(r, "title") ?? "",
        facts: [
          {
            kind: "label",
            key: `gateway.enums.recordKind.${enumKey(str(r, "record_kind") ?? "")}`,
          },
          ...(due
            ? [
                { kind: "label", key: "compassExternal.due" } as const,
                {
                  kind: "instant",
                  at: due,
                  zone: str(r, "time_zone") ?? input.zoneOf(str(r, "project_id")),
                } as const,
              ]
            : []),
        ],
        tag: stateTag("recordState", str(r, "record_state"), {}),
      };
    });
  return section("submittals", "compassExternal.submittals.title", items);
}

// Contractors ------------------------------------------------------------------------------------------------------

function timeEntries(input: PageInput): ExternalSection[] {
  const items = onProject(input, "time_entries")
    .filter((r) => str(r, "engagement_id") !== null)
    .sort(byKey("clock_in", -1))
    .map((r): ExternalItem => {
      const zone = input.zoneOf(str(r, "project_id"));
      const start = str(r, "clock_in");
      const end = str(r, "clock_out");
      const breaks = num(r, "break_minutes") ?? 0;
      const worked =
        start && end
          ? Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 60_000) - breaks)
          : null;
      return {
        id: r.id,
        icon: "clock",
        // No title of its own: the screen leads with the first fact, the clock-in time.
        title: "",
        facts: [
          ...(start ? [{ kind: "instant", at: start, zone } as const] : []),
          ...(end
            ? [
                { kind: "label", key: "compassExternal.timeEntries.until" } as const,
                { kind: "instant", at: end, zone } as const,
              ]
            : [{ kind: "label", key: "compassExternal.timeEntries.open" } as const]),
          ...(worked !== null ? [{ kind: "minutes", minutes: worked } as const] : []),
          ...(breaks > 0
            ? [
                {
                  kind: "label",
                  key: "compassExternal.timeEntries.breaks",
                  values: { minutes: breaks },
                } as const,
              ]
            : []),
        ],
        ...(str(r, "source")
          ? {
              tag: {
                key: `gateway.enums.timeEntrySource.${enumKey(str(r, "source") ?? "")}`,
                tone: "neutral" as const,
              },
            }
          : {}),
      };
    });
  return section("time-entries", "compassExternal.timeEntries.title", items);
}

const DELIVERABLE_TONES: Readonly<Record<string, Tone>> = {
  Open: "accent",
  Submitted: "neutral",
  Accepted: "success",
  Returned: "warning",
};

function deliverables(input: PageInput): ExternalSection[] {
  const items = onProject(input, "deliverables")
    .sort(byKey("due_at"))
    .map((r): ExternalItem => {
      const project = engagementProject(input, str(r, "engagement_id"));
      const zone = input.zoneOf(project);
      const due = str(r, "due_at");
      const state = str(r, "deliverable_state");
      // Overdue once the due instant's day has passed on the project's calendar (23:00 on June 9 in New York is
      // June 10 in UTC, and still June 9 there).
      const overdue =
        due !== null &&
        (state === "Open" || state === "Returned") &&
        dayIn(due, zone) < input.todayOf(project);
      const fee = num(r, "fee_minor");
      const reason = str(r, "return_reason");
      return {
        id: r.id,
        icon: "file-check",
        title: str(r, "title") ?? "",
        facts: [
          ...(due
            ? [
                {
                  kind: "label",
                  key: overdue ? "compassExternal.overdue" : "compassExternal.due",
                } as const,
                { kind: "instant", at: due, zone } as const,
              ]
            : []),
          ...(fee !== null
            ? [{ kind: "money", minor: fee, currency: str(r, "currency_code") ?? "USD" } as const]
            : []),
          ...(reason
            ? [
                {
                  kind: "label",
                  key: "compassExternal.deliverables.returned",
                  values: { reason },
                } as const,
              ]
            : []),
        ],
        tag: overdue
          ? { key: "compassExternal.overdue", tone: "danger" }
          : stateTag("deliverableState", state, DELIVERABLE_TONES),
      };
    });
  return section("deliverables", "compassExternal.deliverables.title", items);
}

// Artists and representatives ----------------------------------------------------------------------------------

function advanceSummary(input: PageInput): ExternalSection[] {
  const sections = input.rows("advance_sections");
  const submissions = input.rows("advance_submissions");
  const items = onProject(input, "advance_packets")
    .sort(byKey("due_at"))
    .map((p): ExternalItem => {
      const zone = input.zoneOf(str(p, "project_id"));
      const due = str(p, "due_at");
      const mine = sections
        .filter((s) => str(s, "advance_packet_id") === p.id)
        .sort((a, b) => (num(a, "position") ?? 0) - (num(b, "position") ?? 0));
      const answered = mine.filter((s) =>
        submissions.some((a) => str(a, "advance_section_id") === s.id),
      ).length;
      return {
        id: p.id,
        icon: "clipboard-list",
        title: str(p, "title") ?? "",
        facts: [
          {
            kind: "label",
            key: "compassExternal.advance.progress",
            values: { done: answered, total: mine.length },
          },
          ...(due
            ? [
                { kind: "label", key: "compassExternal.due" } as const,
                { kind: "instant", at: due, zone } as const,
              ]
            : []),
        ],
        lines: mine.map((s): ExternalItem => {
          const latest = submissions
            .filter((a) => str(a, "advance_section_id") === s.id)
            .sort(byKey("submitted_at", -1))[0];
          const outcome = latest ? str(latest, "review_outcome") : null;
          return {
            id: s.id,
            icon: latest ? "check" : "list",
            title: str(s, "title") ?? "",
            facts: latest
              ? [
                  { kind: "label", key: "compassExternal.advance.answered" },
                  { kind: "instant", at: str(latest, "submitted_at") ?? "", zone },
                  ...(str(latest, "return_reason")
                    ? [
                        {
                          kind: "label",
                          key: "compassExternal.advance.returnedBecause",
                          values: { reason: str(latest, "return_reason") ?? "" },
                        } as const,
                      ]
                    : []),
                ]
              : [{ kind: "label", key: "compassExternal.advance.notAnswered" }],
            ...(outcome
              ? {
                  tag: {
                    key: `gateway.enums.advanceReviewOutcome.${enumKey(outcome)}`,
                    tone: outcome === "Accepted" ? ("success" as const) : ("warning" as const),
                  },
                }
              : {}),
          };
        }),
      };
    });
  return section("advance", "compassExternal.advance.title", items);
}

function rider(input: PageInput): ExternalSection[] {
  const lines = input.rows("rider_lines");
  const items = onProject(input, "riders").map((r): ExternalItem => {
    const mine = lines.filter((l) => str(l, "rider_id") === r.id);
    const fulfilled = mine.filter((l) => str(l, "fulfilled_at") !== null).length;
    return {
      id: r.id,
      icon: "clipboard-list",
      title: str(r, "title") ?? "",
      facts: [
        {
          kind: "label",
          key: "compassExternal.rider.progress",
          values: { done: fulfilled, total: mine.length },
        },
      ],
      lines: mine.map((l): ExternalItem => ({
        id: l.id,
        icon: str(l, "fulfilled_at") ? "check" : "list",
        title: str(l, "description") ?? "",
        facts:
          num(l, "quantity") !== null
            ? [
                {
                  kind: "label",
                  key: "compassExternal.quantity",
                  values: { quantity: num(l, "quantity") ?? 0, unit: "" },
                },
              ]
            : [],
        tag: str(l, "fulfilled_at")
          ? { key: "compassExternal.rider.fulfilled", tone: "success" }
          : { key: "compassExternal.rider.open", tone: "neutral" },
      })),
    };
  });
  return section("rider", "compassExternal.rider.title", items);
}

const SETTLEMENT_TONES: Readonly<Record<string, Tone>> = {
  Submitted: "accent",
  Accepted: "success",
  Disputed: "warning",
  Paid: "success",
};

function settlement(input: PageInput): ExternalSection[] {
  const lines = input.rows("settlement_lines");
  const items = onProject(input, "settlements")
    .sort(byKey("submitted_at", -1))
    .map((s): ExternalItem => {
      const currency = str(s, "currency_code") ?? "USD";
      const net = num(s, "net_minor");
      const settled = str(s, "settled_on");
      return {
        id: s.id,
        icon: "banknote",
        title: str(s, "title") ?? str(s, "settlement_number") ?? "",
        facts: [
          ...(net !== null
            ? [
                { kind: "label", key: "compassExternal.settlement.net" } as const,
                { kind: "money", minor: net, currency } as const,
              ]
            : [{ kind: "label", key: "compassExternal.settlement.unpriced" } as const]),
          ...(settled ? [{ kind: "day", day: settled } as const] : []),
        ],
        tag: stateTag("settlementState", str(s, "settlement_state"), SETTLEMENT_TONES),
        lines: lines
          .filter((l) => str(l, "settlement_id") === s.id)
          .sort((a, b) => (num(a, "line_number") ?? 0) - (num(b, "line_number") ?? 0))
          .map((l): ExternalItem => {
            const kind = str(l, "line_kind") ?? "";
            const amount = num(l, "amount_minor");
            const deduct = kind === "Deduction" || kind === "Withholding";
            return {
              id: l.id,
              icon: "list",
              title: str(l, "description") ?? "",
              facts: [
                { kind: "label", key: `gateway.enums.settlementLineKind.${enumKey(kind)}` },
                ...(amount !== null
                  ? [{ kind: "money", minor: deduct ? -amount : amount, currency } as const]
                  : []),
              ],
            };
          }),
      };
    });
  return section("settlement", "compassExternal.settlement.title", items);
}

// Clients and sponsors -----------------------------------------------------------------------------------------

function reports(input: PageInput): ExternalSection[] {
  const items = onProject(input, "shared_reports")
    .sort(byKey("shared_at", -1))
    .map((r): ExternalItem => {
      const zone = input.zoneOf(str(r, "project_id"));
      const shared = str(r, "shared_at");
      const expires = str(r, "expires_at");
      const rowsCount = num(r, "row_count");
      return {
        id: r.id,
        icon: "chart-column",
        title: str(r, "title") ?? "",
        facts: [
          ...(shared
            ? [
                { kind: "label", key: "compassExternal.reports.shared" } as const,
                { kind: "instant", at: shared, zone } as const,
              ]
            : []),
          ...(rowsCount !== null
            ? [
                {
                  kind: "label",
                  key: "compassExternal.reports.rows",
                  values: { count: rowsCount },
                } as const,
              ]
            : []),
          ...(expires
            ? [
                { kind: "label", key: "compassExternal.reports.expires" } as const,
                { kind: "instant", at: expires, zone } as const,
              ]
            : []),
          ...(str(r, "export_format")
            ? [
                {
                  kind: "label",
                  key: "compassExternal.reports.format",
                  values: { format: str(r, "export_format") ?? "" },
                } as const,
              ]
            : []),
        ],
      };
    });
  return section("reports", "compassExternal.reports.title", items);
}

function proofOfPerformance(input: PageInput): ExternalSection[] {
  const entitlements = onProject(input, "sponsor_entitlements")
    .sort(byKey("due_on"))
    .map((r): ExternalItem => {
      const due = str(r, "due_on");
      const fulfilled = str(r, "fulfilled_at");
      const overdue = !fulfilled && due !== null && due < input.todayOf(str(r, "project_id"));
      const quantity = num(r, "quantity");
      return {
        id: r.id,
        icon: "megaphone",
        title: str(r, "description") ?? "",
        facts: [
          ...(quantity !== null
            ? [
                {
                  kind: "label",
                  key: "compassExternal.quantity",
                  values: { quantity, unit: "" },
                } as const,
              ]
            : []),
          ...(due
            ? [
                {
                  kind: "label",
                  key: overdue ? "compassExternal.overdue" : "compassExternal.due",
                } as const,
                { kind: "day", day: due } as const,
              ]
            : []),
        ],
        tag: fulfilled
          ? { key: "compassExternal.proof.delivered", tone: "success" }
          : overdue
            ? { key: "compassExternal.overdue", tone: "danger" }
            : { key: "compassExternal.proof.waiting", tone: "neutral" },
      };
    });
  const proofs = onProject(input, "engagement_documents")
    .filter((d) => str(d, "document_kind") === "Proof of Performance")
    .map((d): ExternalItem => {
      const expires = str(d, "expires_on");
      return {
        id: d.id,
        icon: "image",
        title: str(d, "title") ?? "",
        facts: expires
          ? [
              { kind: "label", key: "compassExternal.onboarding.expires" },
              { kind: "day", day: expires },
            ]
          : [],
        tag: stateTag("engagementDocumentState", str(d, "engagement_document_state"), {}),
      };
    });
  return [
    ...section("entitlements", "compassExternal.proof.entitlements", entitlements),
    ...section("proofs", "compassExternal.proof.documents", proofs),
  ];
}

// The pages ----------------------------------------------------------------------------------------------------

const CREW: readonly Audience[] = ["crew", "staff"];
const ARTIST: readonly Audience[] = ["artist", "artist-representative"];

/** Every external More page, keyed by its sitemap id (apps/compass/ia/sitemap.yaml). */
export const EXTERNAL_PAGES: Readonly<Record<ExternalPageId, ExternalPage>> = {
  timesheets: {
    id: "timesheets",
    audiences: CREW,
    tables: ["timesheets"],
    gatewayTab: "timesheets",
    icon: "clock",
    emptyKey: "compassExternal.timesheets.empty",
    build: timesheets,
  },
  "per-diem": {
    id: "per-diem",
    audiences: CREW,
    tables: ["per_diems"],
    gatewayTab: "per-diem",
    icon: "banknote",
    emptyKey: "compassExternal.perDiem.empty",
    build: perDiem,
  },
  "travel-and-lodging": {
    id: "travel-and-lodging",
    audiences: CREW,
    tables: ["travel_segments", "lodging", "itinerary_changes"],
    gatewayTab: "travel-and-lodging",
    icon: "plane",
    emptyKey: "compassExternal.travel.empty",
    build: travelAndLodging,
  },
  onboarding: {
    id: "onboarding",
    audiences: CREW,
    tables: ["onboarding_items"],
    gatewayTab: "onboarding",
    icon: "list-checks",
    emptyKey: "compassExternal.onboarding.empty",
    build: onboarding,
  },
  "purchase-orders": {
    id: "purchase-orders",
    audiences: ["vendor"],
    tables: ["purchase_orders", "po_lines"],
    gatewayTab: "purchase-orders",
    icon: "file-text",
    emptyKey: "compassExternal.purchaseOrders.empty",
    build: purchaseOrders,
  },
  deliveries: {
    id: "deliveries",
    audiences: ["vendor"],
    tables: ["deliveries"],
    gatewayTab: "deliveries",
    icon: "truck",
    emptyKey: "compassExternal.deliveries.empty",
    build: deliveries,
  },
  submittals: {
    id: "submittals",
    audiences: ["vendor"],
    tables: ["shared_records"],
    gatewayTab: "submittals",
    icon: "file-check",
    emptyKey: "compassExternal.submittals.empty",
    build: submittals,
  },
  "time-entries": {
    id: "time-entries",
    audiences: ["contractor"],
    tables: ["time_entries"],
    gatewayTab: "time",
    icon: "clock",
    emptyKey: "compassExternal.timeEntries.empty",
    build: timeEntries,
  },
  deliverables: {
    id: "deliverables",
    audiences: ["contractor"],
    tables: ["deliverables"],
    gatewayTab: "deliverables",
    icon: "file-check",
    emptyKey: "compassExternal.deliverables.empty",
    build: deliverables,
  },
  "advance-summary": {
    id: "advance-summary",
    audiences: ARTIST,
    tables: ["advance_packets", "advance_sections", "advance_submissions"],
    gatewayTab: "advance",
    icon: "clipboard-list",
    emptyKey: "compassExternal.advance.empty",
    build: advanceSummary,
  },
  rider: {
    id: "rider",
    audiences: ARTIST,
    tables: ["riders", "rider_lines"],
    gatewayTab: "rider",
    icon: "clipboard-list",
    emptyKey: "compassExternal.rider.empty",
    build: rider,
  },
  settlement: {
    id: "settlement",
    audiences: ARTIST,
    tables: ["settlements", "settlement_lines"],
    gatewayTab: "settlement",
    icon: "banknote",
    emptyKey: "compassExternal.settlement.empty",
    build: settlement,
  },
  reports: {
    id: "reports",
    audiences: ["client"],
    tables: ["shared_reports"],
    gatewayTab: "reports",
    icon: "chart-column",
    emptyKey: "compassExternal.reports.empty",
    build: reports,
  },
  "proof-of-performance": {
    id: "proof-of-performance",
    audiences: ["sponsor"],
    tables: ["sponsor_entitlements", "engagement_documents"],
    gatewayTab: "proof-of-performance",
    icon: "megaphone",
    emptyKey: "compassExternal.proof.empty",
    build: proofOfPerformance,
  },
};

export function isExternalPage(id: string): id is ExternalPageId {
  return Object.prototype.hasOwnProperty.call(EXTERNAL_PAGES, id);
}

/**
 * The engagement whose Gateway tab holds a page's actions: the person's engagement on the current project with a
 * role type the page serves, preferring one whose operational area is open.
 */
export function engagementFor(
  page: ExternalPage,
  engagements: readonly EngagementSummary[],
  projectId: string | null,
): EngagementSummary | null {
  const candidates = engagements.filter(
    (e) => (projectId === null || e.projectId === projectId) && page.audiences.includes(e.roleType),
  );
  return (
    candidates.find((e) => e.state === "Active" || e.state === "Closing") ??
    candidates.find((e) => e.state === "Onboarding" || e.state === "Blocked") ??
    candidates[0] ??
    null
  );
}

/** The Gateway page with the page's actions, on that engagement: /work/engagements/{key}/{tab}. */
export function gatewayTabUrl(gatewayUrl: string, engagementKey: string, tab: string): string {
  return `${gatewayUrl.replace(/\/+$/, "")}/work/engagements/${encodeURIComponent(engagementKey)}/${tab}`;
}
