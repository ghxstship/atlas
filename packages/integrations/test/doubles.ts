import type { DbClient, DbResponse } from "../src/framework/db.ts";
import type { HttpClient, HttpRequest, HttpResponse } from "../src/framework/http.ts";
import type { ExternalId, IntegrationStore, ItemRef, SyncRun } from "../src/framework/store.ts";
import type { SyncContext } from "../src/framework/connector.ts";
import type { Connection } from "../src/framework/store.ts";
import type { Credential } from "../src/framework/support.ts";

/** A recording database client: each from(relation) or rpc(name) takes the next queued response. */
export interface Call {
  readonly target: string;
  readonly steps: [string, unknown[]][];
}

export function recordingDb(queues: Record<string, DbResponse[]>) {
  const calls: Call[] = [];
  const take = (key: string): DbResponse => {
    const next = queues[key]?.shift();
    if (!next) throw new Error(`no queued response for ${key}`);
    return next;
  };
  const builder = (key: string, steps: [string, unknown[]][]) => {
    let response: DbResponse | undefined;
    const proxy: Record<string, unknown> = new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === "then") {
            response ??= take(key);
            const settled = response;
            return (resolve: (r: DbResponse) => unknown) => resolve(settled);
          }
          return (...args: unknown[]) => {
            steps.push([prop, args]);
            return proxy;
          };
        },
      },
    );
    return proxy;
  };
  const db = {
    from(relation: string) {
      const call: Call = { target: `from:${relation}`, steps: [] };
      calls.push(call);
      return builder(`from:${relation}`, call.steps);
    },
    rpc(name: string, args: unknown) {
      const call: Call = { target: `rpc:${name}`, steps: [["args", [args]]] };
      calls.push(call);
      return builder(`rpc:${name}`, call.steps);
    },
  };
  return { db: db as unknown as DbClient, calls };
}

export const okData = (data: unknown): DbResponse => ({ data, error: null });
export const dbError = (code: string, message: string, hint?: string): DbResponse => ({
  data: null,
  error: { code, message, hint: hint ?? null },
});

/** A scripted provider: routes are matched by "METHOD url-prefix"; every request is recorded. */
export interface Route {
  readonly match: string;
  readonly respond: (request: HttpRequest) => Partial<HttpResponse> & { json?: unknown };
}

export function scriptedHttp(routes: Route[]) {
  const requests: HttpRequest[] = [];
  const http: HttpClient = async (request) => {
    requests.push(request);
    const route = routes.find((r) => {
      const [method, prefix] = r.match.split(" ");
      return method === request.method && prefix !== undefined && request.url.startsWith(prefix);
    });
    if (!route)
      return { status: 599, headers: {}, body: `no route for ${request.method} ${request.url}` };
    const result = route.respond(request);
    return {
      status: result.status ?? 200,
      headers: result.headers ?? {},
      body: result.json !== undefined ? JSON.stringify(result.json) : (result.body ?? ""),
      ...(result.bytes !== undefined ? { bytes: result.bytes } : {}),
    };
  };
  return { http, requests };
}

export function bodyOf(request: HttpRequest | undefined): unknown {
  if (request?.body === undefined) return undefined;
  return JSON.parse(
    typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body),
  );
}

/** An in-memory framework store that records what connectors report. */
export function memoryStore(initial: ExternalId[] = []) {
  const externalIds: ExternalId[] = [...initial];
  const itemErrors: { code: string; message: string; ref?: ItemRef | undefined }[] = [];
  const store: IntegrationStore = {
    claimRun: () => Promise.reject(new Error("claimRun is not used by connector tests")),
    connection: () => Promise.reject(new Error("connection is not used by connector tests")),
    credential: () => Promise.reject(new Error("credential is not used by connector tests")),
    lastCursor: () => Promise.resolve(null),
    completeRun: () => Promise.resolve(),
    failRun: () => Promise.resolve("Failed"),
    async recordItemError(_run, code, message, ref) {
      itemErrors.push({ code, message, ref });
    },
    async externalIds(_connection, entity) {
      return externalIds.filter((e) => e.entity === entity);
    },
    async upsertExternalId(_connection, pair) {
      const index = externalIds.findIndex(
        (e) => e.entity === pair.entity && e.localId === pair.localId,
      );
      if (index >= 0) externalIds[index] = pair;
      else externalIds.push(pair);
    },
  };
  return { store, externalIds, itemErrors };
}

export function syncRun(overrides: Partial<SyncRun> = {}): SyncRun {
  return {
    id: "run-1",
    orgId: "org-1",
    connectionId: "conn-1",
    projectId: null,
    scope: "Ledger Export",
    direction: "Outbound",
    state: "Running",
    attempt: 1,
    maxAttempts: 5,
    cursorBefore: null,
    subjectEntity: null,
    subjectId: null,
    sourceUri: null,
    ...overrides,
  };
}

export function connectionOf(
  providerCode: string,
  settings: Record<string, unknown> = {},
): Connection {
  return {
    id: "conn-1",
    orgId: "org-1",
    providerCode,
    displayName: "Northwind",
    externalAccountId: "acct-1",
    settings,
    state: "Connected",
  };
}

export function contextFor(
  providerCode: string,
  options: {
    http: HttpClient;
    store: IntegrationStore;
    run?: Partial<SyncRun>;
    settings?: Record<string, unknown>;
    credential?: Credential | null;
    cursor?: string | null;
  },
): SyncContext {
  return {
    run: syncRun(options.run),
    connection: connectionOf(providerCode, options.settings),
    credential:
      options.credential === undefined
        ? { token: "fixture-token", fields: {} }
        : options.credential,
    http: options.http,
    store: options.store,
    cursor: options.cursor ?? null,
    now: () => new Date("2027-06-30T12:00:00Z"),
  };
}
