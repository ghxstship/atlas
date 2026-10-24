import { fail, ok, toDataError, type Result } from "@xos/data";
import type { ProviderCode } from "../../framework/catalog.ts";
import { ItemTally, type Connector, type SyncContext } from "../../framework/connector.ts";
import { unwrap, type DbClient } from "../../framework/db.ts";
import { IntegrationError } from "../../framework/errors.ts";
import { callJson, callRaw, type HttpRequest } from "../../framework/http.ts";
import { sha256Hex } from "../../framework/support.ts";

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

function credentialOf(context: SyncContext) {
  if (context.credential === null) {
    throw new IntegrationError("credential_required", "The connection has no stored credential.", {
      connectionError: true,
    });
  }
  return context.credential;
}

/** DHL's API key, stored as the connection's credential. */
function key(context: SyncContext): string {
  return credentialOf(context).token;
}

// Access tokens (UPS and FedEx) ------------------------------------------------------------------------------------------

const CLIENT_CREDENTIAL_PROVIDERS: readonly string[] = ["ups", "fedex"] satisfies ProviderCode[];

/** Whether the provider's connection stores a developer app's client ID and secret instead of a token. */
export function usesClientCredentials(code: string): boolean {
  return CLIENT_CREDENTIAL_PROVIDERS.includes(code);
}

/** A minted token stops being reused this long before the expiry the carrier stated. */
export const TOKEN_SAFETY_MARGIN_MS = 5 * 60_000;

interface MintedToken {
  /** SHA-256 of the client ID and secret it was minted from, so a rotated pair never reuses it. */
  readonly fingerprint: string;
  readonly accessToken: string;
  readonly usableUntil: number;
}

/**
 * Access tokens minted with the OAuth 2.0 client-credentials grant, one per connection, kept until
 * TOKEN_SAFETY_MARGIN_MS before they expire. The worker keeps one cache for as long as its isolate lives,
 * so a warm worker reuses a token across runs; tests pass their own.
 */
export class CarrierTokenCache {
  private readonly tokens = new Map<string, MintedToken>();

  get(connectionId: string, fingerprint: string, now: number): string | null {
    const cached = this.tokens.get(connectionId);
    if (cached === undefined) return null;
    if (cached.fingerprint !== fingerprint || now >= cached.usableUntil) {
      this.tokens.delete(connectionId);
      return null;
    }
    return cached.accessToken;
  }

  set(connectionId: string, token: MintedToken): void {
    this.tokens.set(connectionId, token);
  }

  forget(connectionId: string): void {
    this.tokens.delete(connectionId);
  }
}

const workerTokens = new CarrierTokenCache();

interface ClientPair {
  readonly clientId: string;
  readonly clientSecret: string;
}

interface TokenEndpoint {
  readonly label: string;
  request(pair: ClientPair): HttpRequest;
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

/** Base64 of UTF-8 text without Node's Buffer, so the worker also runs in Deno. */
function base64(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** UPS takes the pair as HTTP Basic authentication. */
const UPS_TOKEN: TokenEndpoint = {
  label: "UPS",
  request: (pair) => ({
    method: "POST",
    url: "https://onlinetools.ups.com/security/v1/oauth/token",
    headers: {
      accept: "application/json",
      authorization: `Basic ${base64(`${pair.clientId}:${pair.clientSecret}`)}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form({ grant_type: "client_credentials" }),
  }),
};

/** FedEx takes the pair (its "API key" and "secret key") in the form body. */
const FEDEX_TOKEN: TokenEndpoint = {
  label: "FedEx",
  request: (pair) => ({
    method: "POST",
    url: "https://apis.fedex.com/oauth/token",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: form({
      grant_type: "client_credentials",
      client_id: pair.clientId,
      client_secret: pair.clientSecret,
    }),
  }),
};

function clientPair(context: SyncContext, label: string): ClientPair {
  const fields = credentialOf(context).fields;
  const clientId = fields["client_id"] ?? "";
  const clientSecret = fields["client_secret"] ?? "";
  if (clientId.length === 0 || clientSecret.length === 0) {
    throw new IntegrationError(
      "credential_incomplete",
      `${label} needs the client ID and client secret of a ${label} developer app. Store them on the connection in Settings, Integrations.`,
      { connectionError: true },
    );
  }
  return { clientId, clientSecret };
}

/** Every form a credential could take in a provider's error body: raw, form-encoded and Basic. */
function secretsOf(pair: ClientPair, ...tokens: string[]): string[] {
  return [
    pair.clientSecret,
    form({ s: pair.clientSecret }).slice(2),
    base64(`${pair.clientId}:${pair.clientSecret}`),
    pair.clientId,
    ...tokens,
  ];
}

/**
 * The error with every credential and token cut from its message, so none reaches the run's last error,
 * the connection or a log. Code, retry and connection flags are kept.
 */
function scrubbed(error: unknown, secrets: readonly string[]): unknown {
  if (!(error instanceof Error)) return error;
  let message = error.message;
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret.length > 0) message = message.split(secret).join("[redacted]");
  }
  if (message === error.message) return error;
  if (error instanceof IntegrationError) {
    return new IntegrationError(error.code, message, {
      retryable: error.retryable,
      connectionError: error.connectionError,
      status: error.status,
    });
  }
  const copy = new Error(message);
  copy.name = error.name;
  return copy;
}

async function mint(
  context: SyncContext,
  endpoint: TokenEndpoint,
  pair: ClientPair,
  fingerprint: string,
): Promise<MintedToken> {
  const response = await callRaw(context.http, endpoint.label, endpoint.request(pair)).catch(
    (error: unknown) => {
      throw scrubbed(error, secretsOf(pair));
    },
  );
  let body: { access_token?: unknown; expires_in?: unknown } = {};
  try {
    body = (JSON.parse(response.body) ?? {}) as typeof body;
  } catch {
    // Not JSON: refused below like a body without a token.
  }
  const accessToken = typeof body.access_token === "string" ? body.access_token : "";
  // UPS states the lifetime in seconds as a string, FedEx as a number.
  const lifetimeMs = Number(body.expires_in) * 1000;
  if (accessToken.length === 0 || !Number.isFinite(lifetimeMs) || lifetimeMs <= 0) {
    throw new IntegrationError(
      "provider_malformed_response",
      `${endpoint.label} answered the token request without an access token and its lifetime.`,
      { retryable: true },
    );
  }
  return {
    fingerprint,
    accessToken,
    // A token shorter-lived than twice the margin is still reused for half its life.
    usableUntil:
      context.now().getTime() + Math.max(lifetimeMs - TOKEN_SAFETY_MARGIN_MS, lifetimeMs / 2),
  };
}

/**
 * Runs a carrier call with the connection's access token, minting one from the stored client ID and
 * secret when the cache has none that is still good. A 401 means the carrier dropped the token before its
 * stated expiry: the token is forgotten, a new one minted and the call retried exactly once.
 */
async function withAccessToken<T>(
  context: SyncContext,
  tokens: CarrierTokenCache,
  endpoint: TokenEndpoint,
  call: (accessToken: string) => Promise<T>,
): Promise<T> {
  const pair = clientPair(context, endpoint.label);
  const fingerprint = sha256Hex(`${pair.clientId}\n${pair.clientSecret}`);
  const connectionId = context.connection.id;
  const current = async () => {
    const cached = tokens.get(connectionId, fingerprint, context.now().getTime());
    if (cached !== null) return cached;
    const minted = await mint(context, endpoint, pair, fingerprint);
    tokens.set(connectionId, minted);
    return minted.accessToken;
  };
  const first = await current();
  try {
    return await call(first);
  } catch (error) {
    if (!(error instanceof IntegrationError && error.status === 401)) {
      throw scrubbed(error, secretsOf(pair, first));
    }
    tokens.forget(connectionId);
  }
  const second = await current();
  try {
    return await call(second);
  } catch (error) {
    throw scrubbed(error, secretsOf(pair, first, second));
  }
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

/** UPS tracking, with access tokens minted into `tokens` (the worker's cache unless a test passes one). */
export function upsCarrier(tokens: CarrierTokenCache = workerTokens): Carrier {
  return {
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
        body = await withAccessToken(context, tokens, UPS_TOKEN, (token) =>
          callJson(context.http, "UPS", {
            method: "GET",
            url: `https://onlinetools.ups.com/api/track/v1/details/${encodeURIComponent(trackingNumber)}?locale=en_US`,
            token,
            headers: { transid: context.run.id, transactionsrc: "xos" },
          }),
        );
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
}

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

/** FedEx tracking, with access tokens minted into `tokens` (the worker's cache unless a test passes one). */
export function fedexCarrier(tokens: CarrierTokenCache = workerTokens): Carrier {
  return {
    provider: "fedex",
    label: "FedEx",
    async track(context, trackingNumber) {
      const body = await withAccessToken(context, tokens, FEDEX_TOKEN, (token) =>
        callJson<{
          output?: { completeTrackResults?: { trackResults?: FedexResult[] }[] };
        }>(context.http, "FedEx", {
          method: "POST",
          url: "https://apis.fedex.com/track/v1/trackingnumbers",
          token,
          json: {
            includeDetailedScans: true,
            trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
          },
        }),
      );
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
        deliveredAt:
          status === "Delivered" ? (delivered ?? latest(scans)?.occurredAt ?? null) : null,
        scans,
      };
    },
  };
}

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

export function trackingConnectors(
  source: TrackingSource,
  tokens: CarrierTokenCache = workerTokens,
): Connector[] {
  return [upsCarrier(tokens), fedexCarrier(tokens), dhlCarrier].map((c) =>
    trackingConnector(c, source),
  );
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
