import { notificationKind } from "@xos/schemas/notifications";
import { z } from "zod";
import { clip, localeOf, notificationText } from "./copy.ts";
import type { DeliveryOutcome, Recipient } from "./dispatch.ts";

/**
 * Push notifications through the Expo push service (Section 5, ADR 0030, finding A65-012). Compass
 * registers each device's Expo push token in app.push_subscriptions; this sender claims Push deliveries,
 * pushes every device not yet pushed for the delivery, stores one ticket per device (app.push_tickets,
 * which makes a retry idempotent per delivery and device), and later reads the receipts, revoking the
 * devices Expo reports as DeviceNotRegistered.
 *
 * The contract Compass handles (apps/compass/src/domain/notifications.ts):
 *   - `categoryId` is the kind's push category from notification-kinds.yaml (`approval_request` for
 *     approval.requested), whose Approve and Reject actions answer through notifications.act;
 *   - `data` is { notificationId, kind, subjectTable, subjectId, title, url }, where url is the deep link
 *     (Section 4.5.7: a push always carries one).
 */

/** Expo push service endpoints. */
export const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_PUSH_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
/** Expo accepts at most 100 messages per send and 1,000 ids per receipts request. */
export const EXPO_SEND_BATCH = 100;
export const EXPO_RECEIPT_BATCH = 1000;

export interface PushDevice {
  readonly subscriptionId: string;
  readonly token: string;
}

/** A push delivery claimed from app.claim_notification_deliveries. */
export interface ClaimedPush {
  readonly deliveryId: string;
  readonly notificationId: string;
  readonly orgId: string;
  readonly recipientPersonId: string;
  readonly kind: string;
  readonly categoryCode: string;
  readonly messageArgs: Readonly<Record<string, unknown>>;
  readonly subjectTable: string | null;
  readonly subjectId: string | null;
  /** Devices not yet pushed for this delivery. Empty when every device already has a ticket. */
  readonly devices: readonly PushDevice[];
}

/** One message to the Expo push service. */
export interface PushMessage {
  readonly to: string;
  readonly title: string;
  readonly body: string;
  readonly data: Readonly<Record<string, string | null>>;
  readonly categoryId?: string;
  readonly sound: "default";
  readonly priority: "high" | "default";
  /** Seconds Expo and the platforms keep trying an offline device. */
  readonly ttl: number;
}

export type PushTicket =
  | { readonly status: "ok"; readonly id: string }
  | { readonly status: "error"; readonly message: string; readonly error: string | null };

export type PushReceipt =
  | { readonly status: "ok" }
  | { readonly status: "error"; readonly message: string; readonly error: string | null };

/** The Expo push service, behind an interface so tests and local runs never reach the network. */
export interface PushClient {
  readonly name: string;
  /** Sends up to 100 messages; returns one ticket per message, in order. */
  send(messages: readonly PushMessage[]): Promise<PushTicket[]>;
  /** Reads receipts by ticket id; ids with no receipt yet are absent. */
  receipts(ids: readonly string[]): Promise<Record<string, PushReceipt>>;
}

/** A ticket as app.record_push_tickets stores it. */
export interface DeviceTicket {
  readonly subscriptionId: string;
  readonly status: "ok" | "error";
  readonly ticketId: string | null;
  readonly error: string | null;
  readonly message: string | null;
}

/** A receipt as app.record_push_receipts stores it. */
export interface TicketReceipt {
  readonly ticketId: string;
  readonly status: "ok" | "error";
  readonly error: string | null;
  readonly message: string | null;
}

/** What the push sender needs from the database. */
export interface PushStore {
  claimPush(limit: number): Promise<readonly ClaimedPush[]>;
  recipient(personId: string, orgId: string): Promise<Recipient>;
  /** The Compass deep link of the notification's subject. */
  deepLink(claim: ClaimedPush): Promise<string>;
  recordTickets(deliveryId: string, tickets: readonly DeviceTicket[]): Promise<void>;
  record(
    deliveryId: string,
    outcome: DeliveryOutcome,
    providerMessageId: string | null,
    error: string | null,
  ): Promise<void>;
  /** Ticket ids whose receipts are due. */
  claimReceipts(limit: number): Promise<readonly string[]>;
  /** Records receipts; returns how many devices were revoked. */
  recordReceipts(receipts: readonly TicketReceipt[]): Promise<number>;
}

/** Errors that mean the message can never reach that device: no retry. */
const PERMANENT = new Set(["DeviceNotRegistered", "MessageTooBig"]);

/** The Expo message of one device, in the recipient's locale and time zone. */
export function pushMessage(
  claim: ClaimedPush,
  device: PushDevice,
  recipient: Recipient,
  url: string,
): PushMessage {
  const text = notificationText(
    claim.kind,
    claim.messageArgs,
    localeOf(recipient.locale),
    recipient.timeZone,
  );
  const pushCategory = notificationKind(claim.kind)?.pushCategory ?? null;
  const title = claim.messageArgs["title"];
  return {
    to: device.token,
    title: clip(text.title, 120),
    body: clip(text.body, 900),
    data: {
      notificationId: claim.notificationId,
      kind: claim.kind,
      subjectTable: claim.subjectTable,
      subjectId: claim.subjectId,
      title: typeof title === "string" ? title : null,
      url,
    },
    ...(pushCategory === null ? {} : { categoryId: pushCategory }),
    sound: "default",
    priority: pushCategory === null ? "default" : "high",
    ttl: 60 * 60 * 24,
  };
}

/** The delivery outcome of a delivery's tickets. */
export function outcomeOf(tickets: readonly DeviceTicket[]): {
  outcome: DeliveryOutcome;
  providerMessageId: string | null;
  error: string | null;
} {
  const accepted = tickets.find((t) => t.status === "ok");
  if (accepted) return { outcome: "Sent", providerMessageId: accepted.ticketId, error: null };
  const error = tickets.map((t) => t.message ?? t.error ?? "Expo refused the message").join("; ");
  const permanent = tickets.length > 0 && tickets.every((t) => PERMANENT.has(t.error ?? ""));
  return { outcome: permanent ? "Bounced" : "Failed", providerMessageId: null, error };
}

async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  concurrency: number,
  run: (batch: readonly T[]) => Promise<R[]>,
): Promise<R[]> {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  const results: R[][] = new Array<R[]>(batches.length);
  let next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const index = next;
      next += 1;
      results[index] = await run(batches[index] ?? []);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  return results.flat();
}

export interface PushDispatchOptions {
  readonly limit?: number;
  /** Send requests in flight at once; Expo allows 600 notifications a second per project. */
  readonly concurrency?: number;
}

export interface PushDispatchSummary {
  readonly attempted: number;
  readonly sent: number;
  readonly failed: number;
  readonly bounced: number;
  readonly devices: number;
}

interface Pending {
  readonly claim: ClaimedPush;
  readonly device: PushDevice;
  readonly message: PushMessage;
}

/**
 * Pushes claimed deliveries: one message per device not yet pushed, sent in batches of 100 with a
 * bounded number of requests in flight, one ticket stored per device, then the delivery's outcome
 * (Sent when any device accepted, Bounced when every device is gone, Failed otherwise, which retries
 * with backoff). A delivery whose devices were all pushed before only records its outcome. A failure
 * to render or send is recorded, never dropped.
 */
export async function dispatchPush(
  store: PushStore,
  client: PushClient,
  options: PushDispatchOptions = {},
): Promise<PushDispatchSummary> {
  const claims = await store.claimPush(options.limit ?? 50);
  const pending: Pending[] = [];
  const failedEarly = new Map<string, string>();
  for (const claim of claims) {
    try {
      const recipient = await store.recipient(claim.recipientPersonId, claim.orgId);
      const url = await store.deepLink(claim);
      for (const device of claim.devices)
        pending.push({ claim, device, message: pushMessage(claim, device, recipient, url) });
    } catch (error) {
      failedEarly.set(claim.deliveryId, error instanceof Error ? error.message : String(error));
    }
  }

  const tickets = await inBatches(
    pending,
    EXPO_SEND_BATCH,
    options.concurrency ?? 3,
    async (batch) => {
      try {
        const answer = await client.send(batch.map((p) => p.message));
        return batch.map((p, i): [Pending, PushTicket] => [
          p,
          answer[i] ?? { status: "error", message: "Expo returned no ticket", error: null },
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return batch.map((p): [Pending, PushTicket] => [
          p,
          { status: "error", message, error: "RequestFailed" },
        ]);
      }
    },
  );

  let sent = 0;
  let failed = 0;
  let bounced = 0;
  for (const claim of claims) {
    const early = failedEarly.get(claim.deliveryId);
    if (early !== undefined) {
      await store.record(claim.deliveryId, "Failed", null, early);
      failed += 1;
      continue;
    }
    const mine: DeviceTicket[] = tickets
      .filter(([p]) => p.claim.deliveryId === claim.deliveryId)
      .map(([p, t]) =>
        t.status === "ok"
          ? {
              subscriptionId: p.device.subscriptionId,
              status: "ok",
              ticketId: t.id,
              error: null,
              message: null,
            }
          : {
              subscriptionId: p.device.subscriptionId,
              status: "error",
              ticketId: null,
              error: t.error,
              message: t.message,
            },
      );
    if (mine.length > 0) await store.recordTickets(claim.deliveryId, mine);
    // No device left to push means every device was pushed on an earlier attempt.
    const result =
      claim.devices.length === 0
        ? { outcome: "Sent" as const, providerMessageId: null, error: null }
        : outcomeOf(mine);
    await store.record(claim.deliveryId, result.outcome, result.providerMessageId, result.error);
    if (result.outcome === "Sent") sent += 1;
    else if (result.outcome === "Bounced") bounced += 1;
    else failed += 1;
  }
  return { attempted: claims.length, sent, failed, bounced, devices: pending.length };
}

export interface ReceiptSummary {
  readonly checked: number;
  readonly pruned: number;
}

/**
 * Reads the receipts of tickets at least 15 minutes old (Expo keeps them 24 hours) and records them:
 * Delivered, or the error; DeviceNotRegistered revokes the device so it is never pushed again.
 */
export async function checkPushReceipts(
  store: PushStore,
  client: PushClient,
): Promise<ReceiptSummary> {
  const ids = await store.claimReceipts(EXPO_RECEIPT_BATCH);
  if (ids.length === 0) return { checked: 0, pruned: 0 };
  const receipts = await client.receipts(ids);
  const rows: TicketReceipt[] = Object.entries(receipts).map(([ticketId, r]) =>
    r.status === "ok"
      ? { ticketId, status: "ok", error: null, message: null }
      : { ticketId, status: "error", error: r.error, message: r.message },
  );
  if (rows.length === 0) return { checked: 0, pruned: 0 };
  return { checked: rows.length, pruned: await store.recordReceipts(rows) };
}

// The Expo push service over fetch ---------------------------------------------------------------

/** A send or receipts request failed after its retries. */
export class PushServiceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "PushServiceError";
    this.status = status;
  }
}

const ticketSchema = z.union([
  z.object({ status: z.literal("ok"), id: z.string().min(1) }),
  z.object({
    status: z.literal("error"),
    message: z.string().default(""),
    details: z.object({ error: z.string().optional() }).loose().optional(),
  }),
]);
const sendReplySchema = z.object({ data: z.array(ticketSchema) });
const receiptSchema = z.union([
  z.object({ status: z.literal("ok") }).loose(),
  z.object({
    status: z.literal("error"),
    message: z.string().default(""),
    details: z.object({ error: z.string().optional() }).loose().optional(),
  }),
]);
const receiptsReplySchema = z.object({ data: z.record(z.string(), receiptSchema) });

export interface ExpoPushOptions {
  /** Expo access token, when the project turned on enhanced push security. Optional otherwise. */
  readonly accessToken?: string | null;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Attempts per request, retrying rate limits, server errors and network failures with backoff. */
  readonly attempts?: number;
}

/** The Expo push service over its REST API, with retries and backoff; no SDK dependency. */
export function expoPushClient(options: ExpoPushOptions = {}): PushClient {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const attempts = options.attempts ?? 4;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate",
    "Content-Type": "application/json",
  };
  if (options.accessToken) headers["Authorization"] = `Bearer ${options.accessToken}`;

  async function post(url: string, body: unknown): Promise<unknown> {
    let lastError = "";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await doFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });
        const status = response.status;
        if (response.ok) return (await response.json()) as unknown;
        lastError = `Expo answered ${response.status}: ${(await response.text()).slice(0, 300)}`;
        if (status !== 429 && status < 500) throw new PushServiceError(status, lastError);
        const retryAfter = Number(response.headers.get("retry-after"));
        if (attempt < attempts)
          await sleep(
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : 500 * 2 ** (attempt - 1),
          );
      } catch (error) {
        if (error instanceof PushServiceError) throw error;
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1));
      }
    }
    throw new PushServiceError(503, lastError);
  }

  return {
    name: "expo",
    async send(messages) {
      if (messages.length > EXPO_SEND_BATCH)
        throw new PushServiceError(
          400,
          `Expo takes at most ${EXPO_SEND_BATCH} messages per request`,
        );
      const reply = sendReplySchema.parse(await post(EXPO_PUSH_SEND_URL, messages));
      return reply.data.map((t): PushTicket =>
        t.status === "ok"
          ? { status: "ok", id: t.id }
          : { status: "error", message: t.message, error: t.details?.error ?? null },
      );
    },
    async receipts(ids) {
      const out: Record<string, PushReceipt> = {};
      for (let i = 0; i < ids.length; i += EXPO_RECEIPT_BATCH) {
        const reply = receiptsReplySchema.parse(
          await post(EXPO_PUSH_RECEIPTS_URL, { ids: ids.slice(i, i + EXPO_RECEIPT_BATCH) }),
        );
        for (const [id, r] of Object.entries(reply.data)) {
          out[id] =
            r.status === "ok"
              ? { status: "ok" }
              : { status: "error", message: r.message, error: r.details?.error ?? null };
        }
      }
      return out;
    },
  };
}

/**
 * Records pushes instead of sending them: tests, local development and every environment without
 * XOS_PUSH_TRANSPORT=expo. Every message gets an accepted ticket and every receipt is ok.
 */
export class RecordingPushClient implements PushClient {
  readonly name = "record";
  readonly sent: PushMessage[] = [];

  async send(messages: readonly PushMessage[]): Promise<PushTicket[]> {
    return messages.map((m) => {
      this.sent.push(m);
      return { status: "ok", id: `recorded-push-${this.sent.length}` };
    });
  }

  async receipts(ids: readonly string[]): Promise<Record<string, PushReceipt>> {
    return Object.fromEntries(ids.map((id) => [id, { status: "ok" } as const]));
  }
}

export const pushEnvSchema = z.object({
  XOS_PUSH_TRANSPORT: z.enum(["record", "expo"]).default("record"),
  EXPO_ACCESS_TOKEN: z.string().min(20).optional(),
});
export type PushEnv = z.output<typeof pushEnvSchema>;

/** Parses the push environment, naming each bad variable without echoing its value. */
export function readPushEnv(source: Readonly<Record<string, string | undefined>>): PushEnv {
  const parsed = pushEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `Invalid push environment: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  return parsed.data;
}

/** The client the environment asks for: Expo with XOS_PUSH_TRANSPORT=expo, recording otherwise. */
export function createPushClient(env: PushEnv, fetchImpl?: typeof fetch): PushClient {
  if (env.XOS_PUSH_TRANSPORT !== "expo") return new RecordingPushClient();
  return expoPushClient({
    accessToken: env.EXPO_ACCESS_TOKEN ?? null,
    ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
  });
}
