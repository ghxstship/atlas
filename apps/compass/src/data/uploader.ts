/**
 * Sends queued mutations to the server. Inserts and updates go to the app tables (RLS decides), RPCs to
 * the named function, and the kiosk punch to A18's Edge Function. Module repository functions from
 * @xos/data (A12 assets, A14 credentials and incidents) plug in as routes as they land; their Result
 * shape maps to an upload outcome by the module agents' contract: refusal, not-found, conflict and invalid
 * are permanent, unexpected is transient, and a replayed id returns ok with the existing row.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ageAtUpload,
  classifyServerError,
  type DeviceClock,
  type Mutation,
  type Row,
  type UploadOutcome,
  type Uploader,
} from "@xos/sync";

function asRow(value: unknown): Row | null {
  return value && typeof value === "object" && !Array.isArray(value) && "id" in value
    ? (value as Row)
    : null;
}

/** The A14 and A12 Result shape (packages/data/src/result.ts), redeclared structurally. */
export type DataResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly error:
        | { readonly kind: "refusal"; readonly rule: string; readonly message: string }
        | { readonly kind: "not-found" }
        | { readonly kind: "conflict" | "invalid"; readonly message: string }
        | { readonly kind: "unexpected"; readonly message: string; readonly code?: string };
    };

export function outcomeFromResult<T>(
  result: DataResult<T>,
  toRow?: (data: T) => Row | null,
): UploadOutcome {
  if (result.ok) return { kind: "applied", serverRow: toRow ? toRow(result.data) : null };
  const error = result.error;
  switch (error.kind) {
    case "refusal":
      return { kind: "refused", error: { code: error.rule, message: error.message } };
    case "not-found":
      return {
        kind: "refused",
        error: { code: "not-found", message: "The record is gone or no longer visible to you." },
      };
    case "conflict":
    case "invalid":
      return { kind: "refused", error: { code: error.kind, message: error.message } };
    case "unexpected":
      return classifyServerError({
        ...(error.code ? { code: error.code } : {}),
        message: error.message,
        status: error.code ? 400 : 0,
      });
  }
}

export type Route = (mutation: Mutation) => Promise<UploadOutcome>;

export interface UploaderOptions {
  readonly client: SupabaseClient;
  /** Base URL of the Supabase project, for Edge Functions. */
  readonly functionsUrl: string;
  /** Returns the current access token for Edge Function calls. */
  readonly accessToken: () => Promise<string | null>;
  readonly routes?: Readonly<Record<string, Route>>;
  readonly fetchImpl?: typeof fetch;
  /** The org the device acts in, for app.apply_sync_mutation. */
  readonly orgId: () => string | null;
  /** A stable id for this install, recorded with each replayed mutation. */
  readonly deviceId: string;
  /** The device clock, for a punch's age at upload. */
  readonly clock: DeviceClock;
}

/**
 * Offline mutations replay through app.apply_sync_mutation, which runs an allowlisted RPC (private.sync_rpcs)
 * exactly once per mutation id and stores its answer. Queued RPC targets carry the schema ("app.call_cue");
 * other targets are plain PostgREST RPC names.
 */
const SYNC_PREFIX = "app.";

/** Refusals that mean the change already happened, so the device takes them as applied. */
const ALREADY_DONE: Readonly<Record<string, readonly string[]>> = {
  "app.call_cue": ["cue_already_called"],
};

/** Strips device-only fields that the server tables do not have. */
const DEVICE_ONLY = new Set([
  "device_geofence_status",
  "device_needs_review",
  "monotonic_at",
  "boot_id",
]);

function serverPayload(payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).filter(([k]) => !DEVICE_ONLY.has(k)));
}

function retryAfter(headers: Headers | undefined): number | undefined {
  const value = headers?.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

export class SupabaseUploader implements Uploader {
  readonly #options: UploaderOptions;

  constructor(options: UploaderOptions) {
    this.#options = options;
  }

  async upload(mutation: Mutation): Promise<UploadOutcome> {
    const route = this.#options.routes?.[mutation.target];
    if (route) return route(mutation);
    if (mutation.target === "kiosk-punch") return this.#edgeFunction("kiosk-punch", mutation);
    if (mutation.op === "insert") return this.#insert(mutation);
    if (mutation.op === "update") return this.#update(mutation);
    return this.#rpc(mutation);
  }

  async #insert(mutation: Mutation): Promise<UploadOutcome> {
    const { data, error, status } = await this.#options.client
      .from(mutation.target)
      .insert(serverPayload(mutation.payload))
      .select()
      .maybeSingle();
    if (error) return classifyServerError({ ...error, status });
    return { kind: "applied", serverRow: (data as Row | null) ?? null };
  }

  /**
   * Guarded and merge updates apply only when the server row still matches the base the person edited
   * (updated_at), and report stale with the server's row otherwise.
   */
  async #update(mutation: Mutation): Promise<UploadOutcome> {
    let query = this.#options.client
      .from(mutation.target)
      .update(serverPayload(mutation.payload))
      .eq("id", mutation.rowId);
    const baseStamp = mutation.base?.["updated_at"];
    if (mutation.policy !== "append" && typeof baseStamp === "string")
      query = query.eq("updated_at", baseStamp);
    const { data, error, status } = await query.select().maybeSingle();
    if (error) return classifyServerError({ ...error, status });
    if (data) return { kind: "applied", serverRow: data as Row };
    const current = await this.#options.client
      .from(mutation.target)
      .select()
      .eq("id", mutation.rowId)
      .maybeSingle();
    if (current.error) return classifyServerError({ ...current.error, status: current.status });
    if (!current.data) {
      return {
        kind: "refused",
        error: { code: "not-found", message: "The record is gone or no longer visible to you." },
      };
    }
    return { kind: "stale", serverRow: current.data as Row };
  }

  /** Named RPC arguments; a punch gets its monotonic age at the moment it is sent. */
  #rpcArgs(mutation: Mutation): Record<string, unknown> {
    const args = serverPayload(mutation.payload);
    const monotonicAt = mutation.payload["monotonic_at"];
    const bootId = mutation.payload["boot_id"];
    if (typeof monotonicAt === "number" && typeof bootId === "string") {
      args["p_monotonic_offset_ms"] = ageAtUpload(this.#options.clock, { monotonicAt, bootId });
    }
    return args;
  }

  async #rpc(mutation: Mutation): Promise<UploadOutcome> {
    if (mutation.target.startsWith(SYNC_PREFIX)) return this.#replay(mutation);
    const { data, error, status } = await this.#options.client.rpc(
      mutation.target,
      this.#rpcArgs(mutation),
    );
    if (error) {
      // A compare-and-set RPC refuses a mismatched expected state; the server row decides the conflict.
      if (
        mutation.policy === "cas" &&
        error.code === "XR001" &&
        /stale|expected/i.test(error.message)
      ) {
        const current = await this.#options.client
          .from(mutation.table)
          .select()
          .eq("id", mutation.rowId)
          .maybeSingle();
        return {
          kind: "stale",
          serverRow: (current.data as Row | null) ?? null,
          error: { code: "XR001", message: error.message },
        };
      }
      return classifyServerError({ ...error, status });
    }
    return { kind: "applied", serverRow: asRow(Array.isArray(data) ? data[0] : data) };
  }

  async #replay(mutation: Mutation): Promise<UploadOutcome> {
    const orgId = this.#options.orgId();
    if (orgId === null) {
      return {
        kind: "unauthorized",
        error: { code: "no-org", message: "Sign in to an organization to upload." },
      };
    }
    const { data, error, status } = await this.#options.client.rpc("apply_sync_mutation", {
      p_mutation_id: mutation.id,
      p_org_id: orgId,
      p_device_id: this.#options.deviceId,
      p_rpc: mutation.target,
      p_args: this.#rpcArgs(mutation),
    });
    if (error) return classifyServerError({ ...error, status });
    const result = (data ?? {}) as {
      data?: unknown;
      refusal?: { rule?: string | null; message?: string };
    };
    if (result.refusal) {
      const rule = result.refusal.rule ?? "refused";
      if (ALREADY_DONE[mutation.target]?.includes(rule))
        return { kind: "applied", serverRow: null };
      return { kind: "refused", error: { code: rule, message: result.refusal.message ?? rule } };
    }
    return { kind: "applied", serverRow: asRow(result.data) };
  }

  async #edgeFunction(name: string, mutation: Mutation): Promise<UploadOutcome> {
    const fetchImpl = this.#options.fetchImpl ?? fetch;
    const token = await this.#options.accessToken();
    let response: Response;
    try {
      response = await fetchImpl(`${this.#options.functionsUrl}/functions/v1/${name}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(mutation.payload),
      });
    } catch (error) {
      return classifyServerError({
        status: 0,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    if (response.ok) return { kind: "applied", serverRow: null };
    const body = (await response.json().catch(() => ({}))) as { reason?: string; title?: string };
    if (response.status === 422) {
      return {
        kind: "refused",
        error: { code: body.reason ?? "refused", message: body.title ?? body.reason ?? "Refused." },
      };
    }
    return classifyServerError(
      { status: response.status, message: body.title ?? response.statusText },
      retryAfter(response.headers),
    );
  }
}
