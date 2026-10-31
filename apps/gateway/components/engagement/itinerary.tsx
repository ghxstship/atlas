import { seenBaseline } from "@xos/data/change-tracking";
import { readView, type ExternalRow } from "@xos/data/gateway";
import {
  buildItinerary,
  type ItemChange,
  type Itinerary,
  type ItineraryItem,
} from "@xos/data/itinerary";
import { ActionButton } from "@/components/actions/action-button";
import { Section } from "@/components/page/page";
import { markItinerarySeenAction, recordItineraryVisitAction } from "@/lib/actions/itinerary";
import { formatDate, formatDateTime } from "@/lib/format";
import { enumLabelKey } from "@/lib/shell/translate";
import { RowList, type RowItem } from "./rows";
import type { TabProps } from "./tab-context";
import { VisitMarker } from "./visit-marker";

/**
 * A whole-stay itinerary (B6, G-65, ADR 0145): the person's travel, hotel nights and, for an artist, their set times,
 * grouped by day by the same builder Compass uses (@xos/data/itinerary), with the rows that changed since they last
 * looked tagged by the fields that changed (api_external.itinerary_changes) and what was removed listed apart. The
 * tab records a visit once it is on screen (VisitMarker), and Mark all as seen moves the marker to now.
 */

type Translate = TabProps["t"];

export interface ItineraryRows {
  readonly travel: readonly ExternalRow<"travel">[];
  readonly lodging: readonly ExternalRow<"lodging">[];
  readonly setTimes?: readonly ExternalRow<"cues">[];
}

/** The itinerary's rows and marks for one engagement; null when a read failed. */
export async function loadItinerary(view: TabProps["view"], rows: ItineraryRows) {
  const [changes, baseline] = await Promise.all([
    readView(view.ctx.db, "itinerary_changes", { eq: { engagement_id: view.engagement.id } }),
    seenBaseline(view.ctx.db, "Itinerary", view.engagement.id),
  ]);
  if (!changes.ok || !baseline.ok) return null;
  const itinerary = buildItinerary({
    travel: rows.travel.map((s) => ({
      id: s.id ?? "",
      travel_mode: s.travel_mode ?? "Flight",
      operator_name: s.operator_name,
      service_identifier: s.service_identifier,
      confirmation_identifier: s.confirmation_identifier,
      departs_from: s.departs_from ?? "",
      departs_at: s.departs_at ?? "",
      departs_time_zone: s.departs_time_zone ?? view.engagement.projectTimeZone ?? "UTC",
      arrives_at_place: s.arrives_at_place ?? "",
      arrives_at: s.arrives_at,
      arrives_time_zone: s.arrives_time_zone ?? view.engagement.projectTimeZone ?? "UTC",
    })),
    lodging: rows.lodging.map((l) => ({
      id: l.id ?? "",
      hotel_name: l.hotel_name,
      block_title: l.block_title,
      guest_name: l.guest_name,
      check_in_on: l.check_in_on ?? "",
      check_out_on: l.check_out_on ?? "",
    })),
    setTimes: (rows.setTimes ?? []).map((c) => ({
      id: c.id ?? "",
      label: c.label ?? "",
      planned_at: c.planned_at,
      duration: c.duration === null ? null : String(c.duration),
    })),
    changes: changes.data,
    projectZone: view.engagement.projectTimeZone,
  });
  return { itinerary, baselineAt: baseline.data };
}

function changedLabel(t: Translate, change: ItemChange | null) {
  if (!change) return undefined;
  if (change.kind === "added") return { label: t("gateway.engagement.itinerary.new") };
  return {
    label: t("gateway.engagement.itinerary.changed", {
      fields: change.fields.map((f) => t(`gateway.engagement.itinerary.fields.${f}`)).join(", "),
    }),
  };
}

function itemRow(item: ItineraryItem, t: Translate, locale: string, zone: string | null): RowItem {
  const changed = changedLabel(t, item.changed);
  const withChange = changed ? { changed } : {};
  if (item.type === "travel") {
    const s = item.travel;
    return {
      id: `travel-${s.id}`,
      title: t("gateway.engagement.travel.route", { from: s.departs_from, to: s.arrives_at_place }),
      meta: [
        [s.operator_name, s.service_identifier].filter(Boolean).join(" "),
        t("gateway.engagement.travel.departs", {
          time: formatDateTime(locale, s.departs_at, s.departs_time_zone),
        }),
        s.arrives_at
          ? t("gateway.engagement.travel.arrives", {
              time: formatDateTime(locale, s.arrives_at, s.arrives_time_zone),
            })
          : null,
        s.confirmation_identifier
          ? t("gateway.engagement.travel.confirmation", { code: s.confirmation_identifier })
          : null,
      ],
      tag: { label: t(enumLabelKey("travelMode", s.travel_mode)), tone: "neutral" },
      ...withChange,
    };
  }
  if (item.type === "set") {
    return {
      id: `set-${item.set.id}`,
      title: item.set.label,
      meta: [t("gateway.engagement.itinerary.set"), formatDateTime(locale, item.at, zone)],
      ...withChange,
    };
  }
  const l = item.lodging;
  return {
    id: `${item.type}-${l.id}`,
    title: l.hotel_name ?? l.block_title ?? "",
    meta: [
      t(
        item.type === "check-in"
          ? "gateway.engagement.itinerary.checkIn"
          : "gateway.engagement.itinerary.checkOut",
      ),
      l.hotel_name ? l.block_title : null,
      l.guest_name,
    ],
    ...withChange,
  };
}

/** The itinerary: one section per day, then what was removed, the first-visit note and Mark all as seen. */
export function ItinerarySections({
  itinerary,
  baselineAt,
  view,
  t,
  locale,
}: {
  itinerary: Itinerary;
  baselineAt: string | null;
} & Pick<TabProps, "view" | "t" | "locale">) {
  const zone = view.engagement.projectTimeZone;
  const engagementId = view.engagement.id;
  return (
    <div className="flex flex-col gap-16">
      <VisitMarker record={recordItineraryVisitAction.bind(null, engagementId)} />
      <div className="flex flex-wrap items-center justify-between gap-12">
        <h2 className="text-text-16 font-semibold">{t("gateway.engagement.itinerary.title")}</h2>
        <ActionButton
          action={markItinerarySeenAction.bind(null, engagementId)}
          label={t("gateway.engagement.itinerary.markAllSeen")}
          icon="Check"
        />
      </div>
      {baselineAt ? null : (
        <p className="text-text-13 text-text-secondary">
          {t("gateway.engagement.itinerary.firstVisit")}
        </p>
      )}
      {itinerary.days.map((day) => (
        <Section
          key={day.date}
          title={t("gateway.engagement.itinerary.day", { date: formatDate(locale, day.date) })}
        >
          <RowList
            label={t("gateway.engagement.itinerary.day", { date: formatDate(locale, day.date) })}
            items={day.items.map((item) => itemRow(item, t, locale, zone))}
          />
        </Section>
      ))}
      {itinerary.removed.length > 0 ? (
        <Section title={t("gateway.engagement.itinerary.removedTitle")}>
          <RowList
            label={t("gateway.engagement.itinerary.removedTitle")}
            items={itinerary.removed.map((r) => ({
              id: `removed-${r.kind}-${r.id}`,
              title: r.title ?? "",
              meta: [
                t(
                  `gateway.engagement.itinerary.removedKind.${r.kind === "set_time" ? "set" : r.kind}`,
                ),
              ],
            }))}
          />
        </Section>
      ) : null}
    </div>
  );
}
