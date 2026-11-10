/**
 * Today's blocks for outside parties (navigation.generated.ts lists them per audience): a vendor's dock slot, load-in
 * and load-out windows and delivery instructions; a contractor's deliverables due and site access times; outside crew's
 * briefings; an artist party's hospitality and guest list; a client's approvals waiting; a sponsor's activation
 * schedule and entitlement checklist. Each reads the current project's rows the REST downloader keeps on the device
 * (domain/todayBlocks.ts picks them); the guest list is read live, as its party, through app.engaged_guest_list.
 */
import type { Row } from "@xos/sync";
import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import {
  activationItems,
  approvalItems,
  briefingItems,
  deliverableItems,
  deliveryWindowItems,
  dockSlotItems,
  entitlementItems,
  hospitalityItems,
  siteAccessItems,
  type TodayItem,
} from "../domain/todayBlocks";
import { formatDay, formatTime } from "../domain/schedule-time";
import { useCompass, useRows } from "../runtime/CompassProvider";
import { countKey } from "../runtime/i18n";
import { Card, ListRow, Text } from "../ui";

/** The Today blocks this module reads; any other block keeps Today's own rendering. */
export const WIRED_BLOCKS = [
  "approvals-waiting",
  "dock-slot",
  "load-in-and-load-out-windows",
  "delivery-instructions",
  "tasks-and-deliverables-due",
  "site-access-times",
  "briefings",
  "hospitality",
  "guest-list",
  "activation-schedule",
  "entitlement-checklist",
] as const;
export type WiredBlock = (typeof WIRED_BLOCKS)[number];

export function isWiredBlock(id: string): id is WiredBlock {
  return (WIRED_BLOCKS as readonly string[]).includes(id);
}

const camel = (id: string) => id.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

function useTable(table: string): Row[] {
  return useRows<Row>(table).rows;
}

export function TodayBlock({
  id,
  projectId,
  zone,
}: {
  readonly id: WiredBlock;
  readonly projectId: string;
  /** The project's time zone, for every time the block shows. */
  readonly zone: string | null;
}): ReactElement {
  const { t } = useTranslation();
  const { resolved } = useCompass();
  const personId = resolved?.identity?.personId ?? null;
  const now = Date.now();
  const dockSlots = useTable("dock_slots");
  const windows = useTable("vendor_delivery_windows");
  const deliverables = useTable("deliverables");
  const credentials = useTable("credentials");
  const briefings = useTable("briefings");
  const hospitality = useTable("hospitality");
  const approvals = useTable("client_approvals");
  const bookings = useTable("space_bookings");
  const entitlements = useTable("sponsor_entitlements");
  const title = t(`nav.compass.content.${camel(id)}`);

  if (id === "guest-list") return <GuestListBlock title={title} projectId={projectId} />;

  const items: TodayItem[] = (() => {
    switch (id) {
      case "dock-slot":
      case "delivery-instructions":
        return dockSlotItems(dockSlots, projectId, now);
      case "load-in-and-load-out-windows":
        return deliveryWindowItems(windows, projectId, now);
      case "tasks-and-deliverables-due":
        return deliverableItems(deliverables, now);
      case "site-access-times":
        return siteAccessItems(credentials, projectId, personId, now);
      case "briefings":
        return briefingItems(briefings, projectId, now);
      case "hospitality":
        return hospitalityItems(hospitality, projectId, now);
      case "approvals-waiting":
        return approvalItems(approvals, projectId);
      case "activation-schedule":
        return activationItems(bookings, projectId, now);
      case "entitlement-checklist":
        return entitlementItems(entitlements, projectId);
    }
  })();

  const when = (item: TodayItem): string | null => {
    if (id === "entitlement-checklist") {
      // due_on is a calendar date: read it as the date itself, never shifted into a zone.
      return item.endsAt
        ? t("compass.today.blocks.due", { day: formatDay(`${item.endsAt}T12:00:00Z`, "UTC") })
        : null;
    }
    if (id === "tasks-and-deliverables-due") {
      return item.endsAt
        ? t("compass.today.blocks.due", { day: formatDay(item.endsAt, zone) })
        : null;
    }
    if (id === "approvals-waiting") {
      return item.startsAt
        ? t("compass.today.blocks.requested", { day: formatDay(item.startsAt, zone) })
        : null;
    }
    if (!item.startsAt) return null;
    const start = `${formatDay(item.startsAt, zone)}, ${formatTime(item.startsAt, zone)}`;
    return item.endsAt ? `${start} – ${formatTime(item.endsAt, zone)}` : start;
  };

  const subtitle = (item: TodayItem): string => {
    const parts: (string | null)[] = [when(item)];
    if (id === "delivery-instructions") {
      if (item.detail)
        parts.push(t("compass.today.blocks.quoteReference", { reference: item.detail }));
    } else if (item.detail) parts.push(item.detail);
    if (item.placesLeft !== undefined)
      parts.push(
        t(countKey("compass.today.blocks.placesLeft", item.placesLeft), { count: item.placesLeft }),
      );
    if (item.quantity !== undefined)
      parts.push(t("compass.today.blocks.quantity", { count: item.quantity }));
    if (item.state) parts.push(t(`compass.today.blocks.deliverableState.${item.state}`));
    if (item.done) parts.push(t("compass.today.blocks.fulfilled"));
    if (item.canceled) parts.push(t("compass.today.blocks.canceled"));
    return parts.filter((p): p is string => p !== null && p !== "").join(" · ");
  };

  return (
    <Card title={title} testID={`today-block-${id}`}>
      {items.length === 0 ? (
        <Text tone="secondary">{t(`compass.today.blocks.empty.${camel(id)}`)}</Text>
      ) : (
        items.map((item) => (
          <ListRow
            key={item.id}
            title={
              id === "delivery-instructions"
                ? t("compass.today.blocks.arriveAt", { zone: item.title })
                : item.title
            }
            subtitle={subtitle(item)}
            {...(item.flagged ? { icon: "triangle-alert" } : {})}
          />
        ))
      )}
    </Card>
  );
}

interface Guest {
  readonly id: string;
  readonly guest_name: string;
  readonly plus_ones: number;
  readonly entry_state: string;
}

/** The artist party's guest list on the project, read live as the party (app.engaged_guest_list, 0965). */
function GuestListBlock({
  title,
  projectId,
}: {
  readonly title: string;
  readonly projectId: string;
}): ReactElement {
  const { t } = useTranslation();
  const { client, resolved, network } = useCompass();
  const engagement = resolved?.identity?.engagements.find(
    (e) =>
      e.projectId === projectId &&
      (e.roleType === "artist" || e.roleType === "artist-representative"),
  );
  const [guests, setGuests] = useState<Guest[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!engagement || !network.isConnected) return undefined;
    let live = true;
    void (async () => {
      const { data, error } = await client.rpc("engaged_guest_list", {
        p_engagement_id: engagement.id,
      });
      if (!live) return;
      if (error) setFailed(true);
      else setGuests((data ?? []) as Guest[]);
    })();
    return () => {
      live = false;
    };
  }, [client, engagement, network.isConnected]);
  const message = !engagement
    ? t("compass.today.blocks.empty.guestList")
    : !network.isConnected && guests === null
      ? t("compass.today.blocks.guestListOffline")
      : failed
        ? t("compass.today.blocks.guestListFailed")
        : guests === null
          ? t("compass.today.blocks.loading")
          : guests.length === 0
            ? t("compass.today.blocks.empty.guestList")
            : null;
  return (
    <Card title={title} testID="today-block-guest-list">
      {message !== null ? (
        <Text tone="secondary">{message}</Text>
      ) : (
        (guests ?? []).map((g) => (
          <ListRow
            key={g.id}
            title={
              g.plus_ones > 0
                ? t(countKey("compass.today.blocks.guestPlusOnes", g.plus_ones), {
                    name: g.guest_name,
                    count: g.plus_ones,
                  })
                : g.guest_name
            }
            subtitle={t(`compass.today.blocks.guestState.${g.entry_state.replace(" ", "")}`)}
          />
        ))
      )}
    </Card>
  );
}
