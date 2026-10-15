import { fail, ok, toDataError, type Result } from "@xos/data";
import type { ProviderCode } from "../../framework/catalog.ts";
import { ItemTally, type Connector, type SyncContext } from "../../framework/connector.ts";
import { unwrap, type DbClient } from "../../framework/db.ts";
import { IntegrationError } from "../../framework/errors.ts";
import { callJson } from "../../framework/http.ts";

export const TRACKING_STATUSES = [
  "Label Created",
  "In Transit",
  "Out for Delivery",
  "Delivered",
  "Exception",
  "Returned",
  "Unknown",
] as const;
export type TrackingStatus = (typeof TRACKING_STATUSES)[number];

export interface TrackingScan {
  readonly status: TrackingStatus;
  readonly code: string;
  readonly description: string;
  readonly location: string | null;
  readonly occurredAt: string;
}

export interface TrackingUpdate {
  readonly status: TrackingStatus;
  readonly statusText: string | null;
  readonly estimatedDeliveryAt: string | null;
  readonly deliveredAt: string | null;
  readonly scans: readonly TrackingScan[];
}

export interface Tracker {
  readonly id: string;
  readonly shipmentId: string;
  readonly trackingNumber: string;
}

export interface TrackingSource {
  /** Live trackers of a connection that have not reached a final status. */
  openTrackers(connectionId: string): Promise<readonly Tracker[]>;
  record(trackerId: string, update: TrackingUpdate): Promise<number>;
}

export interface Carrier {
  readonly provider: ProviderCode;
  readonly label: string;
  /** Null when the carrier does not know the number (yet). */
  track(context: SyncContext, trackingNumber: string): Promise<TrackingUpdate | null>;
}

function key(context: SyncContext): string {
  if (context.credential === null) {
    throw new IntegrationError("credential_required", "The connection has no stored credential.", {
      connectionError: true,
    });
  }
  return context.credential.token;
}

const place = (...parts: (string | undefined | null)[]) => {
  const text = parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(", ");
  return text.length > 0 ? text : null;
};

/** The latest status wins; with no scans the carrier's summary status stands. */
function latest(scans: TrackingScan[]): TrackingScan | undefined {
  return [...scans].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))[0];
}

// UPS --------------------------------------------------------------------------------------------------------------------

const UPS_TYPES: Readonly<Record<string, TrackingStatus>> = {
  M: "Label Created",
  P: "In Transit",
  I: "In Transit",
  O: "Out for Delivery",
  D: "Delivered",
  X: "Exception",
  RS: "Returned",
};

interface UpsActivity {
  status?: { type?: string; code?: string; description?: string };
  location?: { address?: { city?: string; stateProvince?: string; countryCode?: string } };
  date?: string;
  time?: string;
}

/** UPS dates are YYYYMMDD and times HHMMSS in the scan's local time; without a zone they are stored as UTC. */
function upsInstant(date: string | undefined, time: string | undefined): string | null {
  if (date === undefined || !/^\d{8}$/.test(date)) return null;
  const t = time !== undefined && /^\d{6}$/.test(time) ? time : "000000";
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;
}

export const upsCarrier: Carrier = {
  provider: "ups",
  label: "UPS",
  async track(context, trackingNumber) {
    let body: {
      trackResponse?: {
        shipment?: {
          package?: {
            activity?: UpsActivity[];
            deliveryDate?: { type: string; date: string }[];
            currentStatus?: { type?: string; description?: string };
          }[];
        }[];
      };
    };
    try {
      body = await callJson(context.http, "UPS", {
        method: "GET",
        url: `https://onlinetools.ups.com/api/track/v1/details/${encodeURIComponent(trackingNumber)}?locale=en_US`,
        token: key(context),
        headers: { transid: context.run.id, transactionsrc: "xos" },
      });
    } catch (error) {
      if (error instanceof IntegrationError && error.code === "provider_not_found") return null;
      throw error;
    }
    const pkg = body.trackResponse?.shipment?.[0]?.package?.[0];
    if (pkg === undefined) return null;
    const scans: TrackingScan[] = [];
    for (const a of pkg.activity ?? []) {
      const occurredAt = upsInstant(a.date, a.time);
      if (occurredAt === null) continue;
      scans.push({
        status: UPS_TYPES[a.status?.type ?? ""] ?? "Unknown",
        code: a.status?.code ?? a.status?.type ?? "UNKNOWN",
        description: a.status?.description ?? "",
        location: place(
          a.location?.address?.city,
          a.location?.address?.stateProvince,
          a.location?.address?.countryCode,
        ),
        occurredAt,
      });
    }
    const top = latest(scans);
    const status = UPS_TYPES[pkg.currentStatus?.type ?? ""] ?? top?.status ?? "Unknown";
    const estimate = pkg.deliveryDate?.find((d) => d.type !== "DEL");
    const delivered = pkg.deliveryDate?.find((d) => d.type === "DEL");
    return {
      status,
      statusText: pkg.currentStatus?.description ?? top?.description ?? null,
      estimatedDeliveryAt: estimate ? upsInstant(estimate.date, undefined) : null,
      deliveredAt:
        status === "Delivered"
          ? delivered
            ? upsInstant(delivered.date, undefined)
            : (top?.occurredAt ?? null)
          : null,
      scans,
    };
  },
};

// FedEx ------------------------------------------------------------------------------------------------------------------

const FEDEX_CODES: Readonly<Record<string, TrackingStatus>> = {
  OC: "Label Created",
  PU: "In Transit",
  IT: "In Transit",
  AR: "In Transit",
  DP: "In Transit",
  OD: "Out for Delivery",
  DL: "Delivered",
  DE: "Exception",
  SE: "Exception",
  CA: "Exception",
  RS: "Returned",
};

interface FedexResult {
  latestStatusDetail?: { code?: string; description?: string };
  scanEvents?: {
    date?: string;
    eventType?: string;
    eventDescription?: string;
    derivedStatusCode?: string;
    scanLocation?: { city?: string; stateOrProvinceCode?: string; countryCode?: string };
  }[];
  estimatedDeliveryTimeWindow?: { window?: { ends?: string } };
  dateAndTimes?: { type?: string; dateTime?: string }[];
  error?: { code?: string };
}

export const fedexCarrier: Carrier = {
  provider: "fedex",
  label: "FedEx",
  async track(context, trackingNumber) {
    const body = await callJson<{
      output?: { completeTrackResults?: { trackResults?: FedexResult[] }[] };
    }>(context.http, "FedEx", {
      method: "POST",
      url: "https://apis.fedex.com/track/v1/trackingnumbers",
      token: key(context),
      json: {
        includeDetailedScans: true,
        trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
      },
    });
    const result = body.output?.completeTrackResults?.[0]?.trackResults?.[0];
    if (result === undefined || result.error?.code === "TRACKING.TRACKINGNUMBER.NOTFOUND")
      return null;
    const scans: TrackingScan[] = (result.scanEvents ?? [])
      .filter((e) => typeof e.date === "string")
      .map((e) => ({
        status: FEDEX_CODES[e.derivedStatusCode ?? e.eventType ?? ""] ?? "Unknown",
        code: e.eventType ?? e.derivedStatusCode ?? "UNKNOWN",
        description: e.eventDescription ?? "",
        location: place(
          e.scanLocation?.city,
          e.scanLocation?.stateOrProvinceCode,
          e.scanLocation?.countryCode,
        ),
        occurredAt: new Date(e.date as string).toISOString(),
      }));
    const status =
      FEDEX_CODES[result.latestStatusDetail?.code ?? ""] ?? latest(scans)?.status ?? "Unknown";
    const delivered = result.dateAndTimes?.find((d) => d.type === "ACTUAL_DELIVERY")?.dateTime;
    return {
      status,
      statusText: result.latestStatusDetail?.description ?? null,
      estimatedDeliveryAt: result.estimatedDeliveryTimeWindow?.window?.ends ?? null,
      deliveredAt: status === "Delivered" ? (delivered ?? latest(scans)?.occurredAt ?? null) : null,
      scans,
    };
  },
};

// DHL --------------------------------------------------------------------------------------------------------------------

const DHL_CODES: Readonly<Record<string, TrackingStatus>> = {
  "pre-transit": "Label Created",
  transit: "In Transit",
  delivered: "Delivered",
  failure: "Exception",
  unknown: "Unknown",
};

interface DhlEvent {
  timestamp?: string;
  statusCode?: string;
  status?: string;
  description?: string;
  location?: { address?: { addressLocality?: string } };
}

export const dhlCarrier: Carrier = {
  provider: "dhl",
  label: "DHL",
  async track(context, trackingNumber) {
    let body: {
      shipments?: { status?: DhlEvent; estimatedTimeOfDelivery?: string; events?: DhlEvent[] }[];
    };
    try {
      body = await callJson(context.http, "DHL", {
        method: "GET",
        url: `https://api-eu.dhl.com/track/shipments?trackingNumber=${encodeURIComponent(trackingNumber)}`,
        headers: { "dhl-api-key": key(context) },
      });
    } catch (error) {
      if (error instanceof IntegrationError && error.code === "provider_not_found") return null;
      throw error;
    }
    const shipment = body.shipments?.[0];
    if (shipment === undefined) return null;
    const scans: TrackingScan[] = (shipment.events ?? [])
      .filter((e) => typeof e.timestamp === "string")
      .map((e) => ({
        status: DHL_CODES[e.statusCode ?? ""] ?? "Unknown",
        code: e.statusCode ?? "unknown",
        description: e.description ?? e.status ?? "",
        location: place(e.location?.address?.addressLocality),
        occurredAt: new Date(e.timestamp as string).toISOString(),
      }));
    const status = DHL_CODES[shipment.status?.statusCode ?? ""] ?? "Unknown";
    return {
      status,
      statusText: shipment.status?.description ?? shipment.status?.status ?? null,
      estimatedDeliveryAt: shipment.estimatedTimeOfDelivery ?? null,
      deliveredAt:
        status === "Delivered"
          ? (shipment.status?.timestamp ?? latest(scans)?.occurredAt ?? null)
          : null,
      scans,
    };
  },
};

// Connector --------------------------------------------------------------------------------------------------------------

/** Asks the carrier about every open tracker and records new scans and the latest status. */
export function trackingConnector(carrier: Carrier, source: TrackingSource): Connector {
  return {
    provider: carrier.provider,
    scopes: ["Tracking Refresh"],
    async sync(context) {
      const tally = new ItemTally(context);
      for (const tracker of await source.openTrackers(context.connection.id)) {
        tally.read += 1;
        const update = await carrier.track(context, tracker.trackingNumber);
        if (update === null) {
          await tally.fail(
            "tracking_number_unknown",
            `${carrier.label} does not know this tracking number yet.`,
            { entity: "Shipment", localId: tracker.shipmentId, externalId: tracker.trackingNumber },
          );
          continue;
        }
        const added = await source.record(tracker.id, update);
        if (added > 0) tally.written += 1;
        else tally.skipped += 1;
      }
      return { counts: tally.counts(), cursorAfter: null };
    },
  };
}

export function trackingConnectors(source: TrackingSource): Connector[] {
  return [upsCarrier, fedexCarrier, dhlCarrier].map((c) => trackingConnector(c, source));
}

export function supabaseTrackingSource(db: DbClient): TrackingSource {
  return {
    async openTrackers(connectionId) {
      const rows = await unwrap<{ id: string; shipment_id: string; tracking_number: string }[]>(
        db
          .from("shipment_trackers")
          .select("id, shipment_id, tracking_number")
          .eq("integration_connection_id", connectionId)
          .is("deleted_at", null)
          .not("tracking_status", "in", "(Delivered,Returned)")
          .order("created_at"),
      );
      return rows.map((r) => ({
        id: r.id,
        shipmentId: r.shipment_id,
        trackingNumber: r.tracking_number,
      }));
    },
    async record(trackerId, update) {
      return unwrap<number>(
        db.rpc("record_tracking_update", {
          p_tracker_id: trackerId,
          p_status: update.status,
          p_status_text: update.statusText,
          p_estimated_delivery_at: update.estimatedDeliveryAt,
          p_delivered_at: update.deliveredAt,
          p_events: update.scans.map((s) => ({
            status: s.status,
            code: s.code,
            description: s.description,
            location: s.location,
            occurred_at: s.occurredAt,
          })),
        }),
      );
    },
  };
}

// The interface A11's logistics pages use (as the signed-in person, under RLS) -------------------------------------------------

export interface ShipmentTracking {
  readonly trackerId: string;
  readonly shipmentId: string;
  readonly connectionId: string;
  readonly trackingNumber: string;
  readonly status: TrackingStatus;
  readonly statusText: string | null;
  readonly estimatedDeliveryAt: string | null;
  readonly deliveredAt: string | null;
  readonly lastCheckedAt: string | null;
}

interface TrackerRow {
  id: string;
  shipment_id: string;
  integration_connection_id: string;
  tracking_number: string;
  tracking_status: TrackingStatus;
  carrier_status_text: string | null;
  estimated_delivery_at: string | null;
  delivered_at: string | null;
  last_checked_at: string | null;
}

const TRACKER_COLUMNS =
  "id, shipment_id, integration_connection_id, tracking_number, tracking_status, carrier_status_text, estimated_delivery_at, delivered_at, last_checked_at";

function toTracking(r: TrackerRow): ShipmentTracking {
  return {
    trackerId: r.id,
    shipmentId: r.shipment_id,
    connectionId: r.integration_connection_id,
    trackingNumber: r.tracking_number,
    status: r.tracking_status,
    statusText: r.carrier_status_text,
    estimatedDeliveryAt: r.estimated_delivery_at,
    deliveredAt: r.delivered_at,
    lastCheckedAt: r.last_checked_at,
  };
}

/** Live tracking of the given shipments the caller can read, keyed by shipment id. */
export async function shipmentTracking(
  db: DbClient,
  shipmentIds: readonly string[],
): Promise<Result<ReadonlyMap<string, ShipmentTracking>>> {
  if (shipmentIds.length === 0) return ok(new Map());
  const { data, error } = await db
    .from("shipment_trackers")
    .select(TRACKER_COLUMNS)
    .in("shipment_id", shipmentIds)
    .is("deleted_at", null);
  if (error) return fail(toDataError(error));
  return ok(new Map((data as TrackerRow[]).map((r) => [r.shipment_id, toTracking(r)])));
}

export interface TrackingScanRow {
  readonly status: TrackingStatus;
  readonly code: string;
  readonly description: string;
  readonly location: string | null;
  readonly occurredAt: string;
}

/** The scan history of a tracker, newest first. */
export async function trackingScans(
  db: DbClient,
  trackerId: string,
): Promise<Result<readonly TrackingScanRow[]>> {
  const { data, error } = await db
    .from("shipment_tracking_events")
    .select("tracking_status, carrier_status_code, description, location_text, occurred_at")
    .eq("shipment_tracker_id", trackerId)
    .order("occurred_at", { ascending: false });
  if (error) return fail(toDataError(error));
  return ok(
    (
      data as {
        tracking_status: TrackingStatus;
        carrier_status_code: string;
        description: string;
        location_text: string | null;
        occurred_at: string;
      }[]
    ).map((r) => ({
      status: r.tracking_status,
      code: r.carrier_status_code,
      description: r.description,
      location: r.location_text,
      occurredAt: r.occurred_at,
    })),
  );
}

/** Starts tracking a shipment through a carrier connection; the number defaults to the shipment's. */
export async function startTracking(
  db: DbClient,
  shipmentId: string,
  connectionId: string,
  trackingNumber?: string,
): Promise<Result<ShipmentTracking>> {
  const { data, error } = await db
    .from("shipment_trackers")
    .insert({
      shipment_id: shipmentId,
      integration_connection_id: connectionId,
      ...(trackingNumber ? { tracking_number: trackingNumber.trim() } : {}),
    })
    .select(TRACKER_COLUMNS)
    .single();
  if (error) return fail(toDataError(error));
  return ok(toTracking(data as TrackerRow));
}

/** Stops tracking (soft delete); the scan history stays. */
export async function stopTracking(db: DbClient, trackerId: string): Promise<Result<null>> {
  const { data, error } = await db
    .from("shipment_trackers")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", trackerId)
    .select("id")
    .maybeSingle();
  if (error) return fail(toDataError(error));
  return data === null ? fail({ kind: "not-found" }) : ok(null);
}
