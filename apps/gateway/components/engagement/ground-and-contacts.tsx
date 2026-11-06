import { readView, type ExternalRow } from "@xos/data/gateway";
import { formatPhone, regionFromLocale, toE164 } from "@xos/i18n/formats";
import { Section } from "@/components/page/page";
import { formatDate, formatDateTime } from "@/lib/format";
import { enumLabelKey } from "@/lib/shell/translate";
import { RowList, type RowItem } from "./rows";
import type { TabProps } from "./tab-context";

/**
 * Ground transport, local contacts and booked rooms on the engagement tabs (B5, ADR 0144): the caller's transfers
 * from api_external.my_transfers (as driver, passenger or principal of a passenger), the project's Shared local
 * contacts from api_external.local_contacts with tel: and mailto: links, and the act's rooms from
 * api_external.space_bookings. Each view already limits rows to what the caller may see; these only narrow.
 * Transfers and rooms take their day in the whole-stay itinerary (B6, ./itinerary.tsx); contacts stay a section.
 */

type Role = "Driver" | "Passenger" | "Party";

/** Today in the project's zone, as YYYY-MM-DD. */
function projectToday(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

type TransferRow = ExternalRow<"my_transfers">;
type RoomRow = ExternalRow<"space_bookings">;

/**
 * The caller's transfers on the project, in pickup order; `roles` narrows by the caller's role. Null when the read
 * failed. The itinerary places them on their pickup day (B6).
 */
export async function readTransfers(
  view: TabProps["view"],
  roles?: readonly Role[],
): Promise<TransferRow[] | null> {
  const read = await readView(view.ctx.db, "my_transfers", {
    eq: { project_id: view.engagement.projectId },
    order: ["pickup_at", "asc"],
  });
  if (!read.ok) return null;
  return read.data.filter((r) => !roles || roles.includes(r.my_role as Role));
}

/** One transfer as a row: the route, pickup and drop-off in their zones, driver, vehicle, the flight met, passengers. */
export function transferRow(r: TransferRow, t: TabProps["t"], locale: string): RowItem {
  return {
    id: `transfer-${r.id ?? ""}`,
    title: t("gateway.engagement.travel.route", {
      from: r.pickup_place ?? "",
      to: r.dropoff_place ?? "",
    }),
    meta: [
      t("gateway.engagement.ground.title"),
      r.pickup_at
        ? t("gateway.engagement.ground.pickup", {
            time: formatDateTime(locale, r.pickup_at, r.pickup_time_zone),
          })
        : null,
      r.dropoff_at
        ? t("gateway.engagement.ground.dropoff", {
            time: formatDateTime(locale, r.dropoff_at, r.dropoff_time_zone),
          })
        : null,
      r.driver_name ? t("gateway.engagement.ground.driver", { name: r.driver_name }) : null,
      r.vehicle_label
        ? t("gateway.engagement.ground.vehicle", {
            label: r.vehicle_label,
            type: r.vehicle_type ? t(enumLabelKey("vehicleType", r.vehicle_type)) : "",
          })
        : null,
      r.meets_service_identifier
        ? t("gateway.engagement.ground.meets", {
            flight: r.meets_service_identifier,
            time: r.meets_arrives_at
              ? formatDateTime(locale, r.meets_arrives_at, r.pickup_time_zone)
              : "",
          })
        : null,
      (r.passenger_names ?? []).length > 0
        ? t("gateway.engagement.ground.passengers", {
            names: (r.passenger_names ?? []).join(", "),
          })
        : null,
    ],
    ...(r.status
      ? {
          tag: {
            label: t(enumLabelKey("transferStatus", r.status)),
            tone:
              r.status === "Done"
                ? ("neutral" as const)
                : r.status === "Unassigned"
                  ? ("warning" as const)
                  : ("accent" as const),
          },
        }
      : {}),
  };
}

export interface SharedContact {
  readonly id: string;
  readonly day: string | null;
  readonly role: string;
  readonly title: string | null;
  readonly name: string;
  readonly organization: string | null;
  readonly phone: string | null;
  readonly tel: string | null;
  readonly email: string | null;
}

/** The project's Shared local contacts, today's first, then every-day ones, then other days. */
export async function readSharedContacts(
  view: TabProps["view"],
  locale: string,
): Promise<SharedContact[] | null> {
  const read = await readView(view.ctx.db, "local_contacts", {
    eq: { project_id: view.engagement.projectId },
  });
  if (!read.ok) return null;
  const region = regionFromLocale(locale);
  const today = projectToday(view.engagement.projectTimeZone);
  const rank = (day: string | null) => (day === today ? 0 : day === null ? 1 : 2);
  return read.data
    .map((c) => {
      const tel = c.phone ? toE164(c.phone, region) : null;
      return {
        id: c.id ?? "",
        day: c.day,
        role: c.contact_role ?? "Other",
        title: c.contact_title,
        name: c.display_name ?? "",
        organization: c.organization_name,
        phone: c.phone ? (tel ? formatPhone(tel, region) : c.phone) : null,
        tel,
        email: c.email,
      };
    })
    .sort(
      (a, b) =>
        rank(a.day) - rank(b.day) ||
        (a.day ?? "").localeCompare(b.day ?? "") ||
        a.name.localeCompare(b.name),
    );
}

export function ContactLinks({ contact }: { contact: SharedContact }) {
  return (
    <span className="flex flex-wrap gap-12 text-text-13">
      {contact.phone ? (
        contact.tel ? (
          <a className="text-text-link" href={`tel:${contact.tel}`}>
            {contact.phone}
          </a>
        ) : (
          <span>{contact.phone}</span>
        )
      ) : null}
      {contact.email ? (
        <a className="text-text-link" href={`mailto:${contact.email}`}>
          {contact.email}
        </a>
      ) : null}
    </span>
  );
}

/** The project's Shared local contacts as a section, today's first. */
export async function LocalContactsSection({
  view,
  t,
  locale,
}: Pick<TabProps, "view" | "t" | "locale">) {
  const contacts = await readSharedContacts(view, locale);
  if (!contacts || contacts.length === 0) return null;
  return (
    <Section title={t("gateway.engagement.localContacts.title")}>
      <RowList
        label={t("gateway.engagement.localContacts.title")}
        items={contacts.map((c) => ({
          id: c.id,
          title: c.name,
          meta: [
            t(enumLabelKey("localContactRole", c.role)),
            c.title,
            c.organization,
            c.day
              ? t("gateway.engagement.localContacts.day", { day: formatDate(locale, c.day) })
              : t("gateway.engagement.localContacts.everyDay"),
          ],
          detail: <ContactLinks contact={c} />,
        }))}
      />
    </Section>
  );
}

/** The rooms booked for the engagement, in start order; null when the read failed. */
export async function readRooms(view: TabProps["view"]): Promise<RoomRow[] | null> {
  const read = await readView(view.ctx.db, "space_bookings", {
    eq: { engagement_id: view.engagement.id },
    order: ["starts_at", "asc"],
  });
  return read.ok ? read.data : null;
}

/** One booked room as a row: space, purpose, in, out and the set it serves. */
export function roomRow(
  b: RoomRow,
  t: TabProps["t"],
  locale: string,
  zone: string | null,
): RowItem {
  return {
    id: `room-${b.id ?? ""}`,
    title: b.space_name ?? "",
    meta: [
      b.purpose ? t(enumLabelKey("spaceBookingPurpose", b.purpose)) : null,
      b.starts_at && b.ends_at
        ? t("gateway.engagement.rooms.window", {
            in: formatDateTime(locale, b.starts_at, zone),
            out: formatDateTime(locale, b.ends_at, zone),
          })
        : null,
      b.set_label ? t("gateway.engagement.rooms.set", { set: b.set_label }) : null,
    ],
  };
}

/** The rooms booked for the engagement as a section (the Set Times tab). */
export async function YourRooms({ view, t, locale }: Pick<TabProps, "view" | "t" | "locale">) {
  const rooms = await readRooms(view);
  if (!rooms || rooms.length === 0) return null;
  return (
    <Section title={t("gateway.engagement.rooms.title")}>
      <RowList
        label={t("gateway.engagement.rooms.title")}
        items={rooms.map((b) => roomRow(b, t, locale, view.engagement.projectTimeZone))}
      />
    </Section>
  );
}
