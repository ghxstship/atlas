import {
  asDbClient,
  shipmentTracking,
  trackingScans,
  type TrackingStatus,
} from "@xos/integrations";
import type { XosClient } from "@xos/data";
import { getTranslations } from "next-intl/server";
import { StartTrackingForm, StatusTag, StopTrackingButton } from "./tracking-client";
import { getZonedFormat, Section } from "./kit";

/** How many of the newest carrier scans the record shows. */
const SCAN_LIMIT = 8;

/** `Out for Delivery` becomes `outForDelivery`, the catalog key of the status label. */
function enumKeyOf(value: string): string {
  const words = value.split(/\s+/).filter((w) => w.length > 0);
  return words
    .map((w, i) =>
      i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    )
    .join("");
}

type Tone = "neutral" | "accent" | "success" | "warning" | "danger";

const STATUS_TONE: Record<TrackingStatus, Tone> = {
  "Label Created": "neutral",
  "In Transit": "accent",
  "Out for Delivery": "accent",
  Delivered: "success",
  Exception: "danger",
  Returned: "warning",
  Unknown: "neutral",
};

/**
 * Carrier tracking on the shipment record (Section 17: UPS, FedEx and DHL; A19 0634): the latest
 * normalized status, estimate and delivery, the newest scans, and start or stop for people who write
 * shipments on the project. The integration runner writes every status; this panel never does.
 */
export async function TrackingSection({
  db,
  org,
  orgId,
  shipmentId,
  trackingNumber,
  timeZone,
  canWrite,
}: {
  db: XosClient;
  org: string;
  orgId: string;
  shipmentId: string;
  trackingNumber: string | null;
  timeZone: string;
  canWrite: boolean;
}) {
  const t = (await getTranslations("shipmentTracking")) as unknown as (
    key: string,
    values?: Record<string, string | number>,
  ) => string;
  const format = await getZonedFormat();
  const client = asDbClient(db);
  const trackers = await shipmentTracking(client, [shipmentId]);
  if (!trackers.ok) throw new Error(`Cannot read shipment tracking: ${trackers.error.kind}`);
  const tracker = trackers.data.get(shipmentId) ?? null;

  if (tracker === null) {
    let carriers: { id: string; label: string }[] = [];
    if (canWrite) {
      const { data, error } = await db.rpc("carrier_connections", { p_org_id: orgId });
      if (error) throw new Error(`Cannot read carrier connections: ${error.message}`);
      carriers = (data ?? []).map((c) => ({ id: c.id, label: c.display_name }));
    }
    return (
      <Section id={`tracking-${shipmentId}`} title={t("title")}>
        <p className="m-0 text-text-13 text-text-secondary">
          {!canWrite
            ? t("notTrackedReadOnly")
            : carriers.length === 0
              ? t("noCarriers")
              : t("notTracked")}
        </p>
        {canWrite && carriers.length > 0 ? (
          <StartTrackingForm
            org={org}
            shipmentId={shipmentId}
            carriers={carriers}
            trackingNumber={trackingNumber}
          />
        ) : null}
      </Section>
    );
  }

  const scans = await trackingScans(client, tracker.trackerId);
  if (!scans.ok) throw new Error(`Cannot read tracking scans: ${scans.error.kind}`);
  const facts = [
    t("numberValue", { number: tracker.trackingNumber }),
    tracker.estimatedDeliveryAt && !tracker.deliveredAt
      ? t("estimated", { time: format.dateTime(tracker.estimatedDeliveryAt, timeZone) ?? "" })
      : null,
    tracker.deliveredAt
      ? t("delivered", { time: format.dateTime(tracker.deliveredAt, timeZone) ?? "" })
      : null,
    tracker.lastCheckedAt
      ? t("checked", { time: format.dateTime(tracker.lastCheckedAt, timeZone) ?? "" })
      : t("notCheckedYet"),
  ].filter((f): f is string => typeof f === "string" && f.length > 0);

  return (
    <Section
      id={`tracking-${shipmentId}`}
      title={t("title")}
      actions={
        canWrite ? <StopTrackingButton org={org} trackerId={tracker.trackerId} /> : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-8">
        <StatusTag
          tone={STATUS_TONE[tracker.status]}
          label={t(`status.${enumKeyOf(tracker.status)}`)}
        />
        {tracker.statusText ? <span className="text-text-13">{tracker.statusText}</span> : null}
      </div>
      <p className="m-0 text-text-13 text-text-secondary">{facts.join(" · ")}</p>
      {scans.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("noScans")}</p>
      ) : (
        <ol aria-label={t("scans")} className="m-0 flex list-none flex-col gap-8 p-0">
          {scans.data.slice(0, SCAN_LIMIT).map((scan) => (
            <li
              key={`${scan.occurredAt}-${scan.code}`}
              className="flex flex-col gap-2 border-s border-border-subtle ps-12"
            >
              <span className="text-text-14">{scan.description}</span>
              <span className="text-text-12 text-text-secondary">
                {[format.dateTime(scan.occurredAt, timeZone), scan.location]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
