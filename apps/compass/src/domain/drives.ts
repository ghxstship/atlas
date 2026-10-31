/**
 * Drives (B5, G-33; More > Drives): the transfers the signed-in person drives, today and the days ahead, grouped by
 * the day of the pickup on the project's calendar. Each shows the pickup and drop-off in their own zones, the vehicle
 * and its seats, the passengers with the primary first (api_external.my_transfers lists them that way), the flight it
 * meets, a status worked out on the device from the clock, and the day's Transport contacts to call. Pure, so the
 * screen works offline from the downloaded rows; there is no sync RPC: drives are read-only on the phone.
 */
import type { Row } from "@xos/sync";

export type DriveStatus = "Unassigned" | "Assigned" | "Underway" | "Done";

export interface Drive {
  readonly id: string;
  readonly key: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly pickupPlace: string;
  readonly pickupAt: string;
  readonly pickupTimeZone: string;
  readonly dropoffPlace: string;
  readonly dropoffAt: string;
  readonly dropoffTimeZone: string;
  readonly vehicle: string | null;
  readonly seats: number | null;
  readonly passengers: readonly string[];
  readonly primaryPassenger: string | null;
  readonly meetsFlight: string | null;
  readonly meetsArrivesAt: string | null;
  readonly status: DriveStatus;
}

export interface CallContact {
  readonly id: string;
  readonly name: string;
  readonly title: string | null;
  /** The number a tel: link dials, E.164. */
  readonly tel: string;
}

export interface DriveDay {
  /** YYYY-MM-DD on the project's calendar. */
  readonly day: string;
  readonly drives: readonly Drive[];
  /** The day's Transport contacts with a number that dials. */
  readonly callContacts: readonly CallContact[];
}

const str = (row: Row, key: string): string | null => {
  const v = row[key];
  return typeof v === "string" && v.length > 0 ? v : null;
};

/** The day of an instant on a zone's calendar, YYYY-MM-DD. */
export function dayIn(instant: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(instant));
  } catch {
    return instant.slice(0, 10);
  }
}

/** The status as app.transfer_board works it out: Done after drop-off; Unassigned without a driver or vehicle; Underway between pickup and drop-off. */
export function driveStatus(
  row: {
    readonly pickupAt: string;
    readonly dropoffAt: string;
    readonly hasVehicle: boolean;
    readonly hasDriver: boolean;
  },
  now: number,
): DriveStatus {
  if (now >= Date.parse(row.dropoffAt)) return "Done";
  if (!row.hasDriver || !row.hasVehicle) return "Unassigned";
  if (now >= Date.parse(row.pickupAt)) return "Underway";
  return "Assigned";
}

/** An E.164 number (+ and 7 to 15 digits), the form tel: links dial; null for anything else. */
export function dialable(phone: string | null): string | null {
  if (!phone) return null;
  const compact = phone.trim().replace(/[\s.()-]/g, "");
  return /^\+[1-9][0-9]{6,14}$/.test(compact) ? compact : null;
}

function toDrive(row: Row, now: number): Drive | null {
  const pickupAt = str(row, "pickup_at");
  const dropoffAt = str(row, "dropoff_at");
  if (!pickupAt || !dropoffAt) return null;
  const names = Array.isArray(row["passenger_names"])
    ? (row["passenger_names"] as unknown[]).filter((n): n is string => typeof n === "string")
    : [];
  const seats = typeof row["seats"] === "number" ? row["seats"] : null;
  return {
    id: row.id,
    key: str(row, "transfer_key") ?? "",
    projectId: str(row, "project_id") ?? "",
    projectName: str(row, "project_name") ?? "",
    pickupPlace: str(row, "pickup_place") ?? "",
    pickupAt,
    pickupTimeZone: str(row, "pickup_time_zone") ?? "UTC",
    dropoffPlace: str(row, "dropoff_place") ?? "",
    dropoffAt,
    dropoffTimeZone: str(row, "dropoff_time_zone") ?? "UTC",
    vehicle: str(row, "vehicle_label"),
    seats,
    passengers: names,
    primaryPassenger: str(row, "primary_passenger_name"),
    meetsFlight: str(row, "meets_service_identifier"),
    meetsArrivesAt: str(row, "meets_arrives_at"),
    // The driver is the person reading, so a Driver row always has one.
    status: driveStatus(
      { pickupAt, dropoffAt, hasVehicle: str(row, "vehicle_label") !== null, hasDriver: true },
      now,
    ),
  };
}

/**
 * The person's drives from today on, grouped by pickup day on each project's calendar (`zoneOf`), soonest first,
 * with each day's Transport contacts (rows of the project's local contacts for every day or that day) to call.
 */
export function drivesByDay(input: {
  readonly transfers: readonly Row[];
  readonly contacts: readonly Row[];
  readonly zoneOf: (projectId: string | null) => string;
  readonly now: number;
}): DriveDay[] {
  const days = new Map<string, Drive[]>();
  for (const row of input.transfers) {
    if (row["my_role"] !== "Driver") continue;
    const drive = toDrive(row, input.now);
    if (!drive) continue;
    const zone = input.zoneOf(drive.projectId);
    const today = dayIn(new Date(input.now).toISOString(), zone);
    const day = dayIn(drive.pickupAt, zone);
    if (day < today) continue;
    days.set(day, [...(days.get(day) ?? []), drive]);
  }
  return [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, drives]) => {
      const projects = new Set(drives.map((d) => d.projectId));
      const callContacts = input.contacts
        .filter(
          (c) =>
            c["contact_role"] === "Transport" &&
            projects.has(String(c["project_id"] ?? "")) &&
            (c["day"] === null || c["day"] === undefined || c["day"] === day),
        )
        .flatMap((c): CallContact[] => {
          const tel = dialable(str(c, "phone"));
          return tel
            ? [
                {
                  id: c.id,
                  name: str(c, "display_name") ?? "",
                  title: str(c, "contact_title"),
                  tel,
                },
              ]
            : [];
        });
      return {
        day,
        drives: [...drives].sort((a, b) => a.pickupAt.localeCompare(b.pickupAt)),
        callContacts,
      };
    });
}

/** Today's local contacts of a project with a number to call, every-day ones and today's, by name. */
export function todaysContacts(
  contacts: readonly Row[],
  projectId: string | null,
  today: string,
): CallContact[] {
  return contacts
    .filter(
      (c) =>
        (projectId === null || c["project_id"] === projectId) &&
        (c["day"] === null || c["day"] === undefined || c["day"] === today),
    )
    .flatMap((c): CallContact[] => {
      const tel = dialable(str(c, "phone"));
      return tel
        ? [{ id: c.id, name: str(c, "display_name") ?? "", title: str(c, "contact_title"), tel }]
        : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The device clock, read once per render of the Drives screen. */
export function nowMs(): number {
  return Date.now();
}
