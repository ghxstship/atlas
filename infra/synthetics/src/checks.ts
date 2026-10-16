/**
 * The synthetic checks (Section 5.1: sign-in, an API read, a Realtime subscription and a Compass
 * sync, plus Gateway and notifications for the status page components). Every check is read-only:
 * none creates, changes or sends anything. Secrets reach a check only through environment
 * variables the scheduler injects; no check logs or returns them.
 */

import type { CheckContext, CheckDefinition, ProbeOutcome } from "./types.ts";

const RUNBOOK = "infra/runbooks/incident-response.md";

const ok: ProbeOutcome = { ok: true };
const failed = (detail: string): ProbeOutcome => ({ ok: false, detail });

function base(url: string | undefined): string {
  return (url ?? "").replace(/\/+$/, "");
}

async function request(
  context: CheckContext,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  return context.fetch(url, {
    redirect: "manual",
    ...init,
    headers: {
      "user-agent": "xos-synthetics/1",
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(context.timeoutMs),
  });
}

function expectStatus(response: Response, expected: number): ProbeOutcome | null {
  return response.status === expected ? null : failed(`status_${response.status}`);
}

/** Signs the synthetic user in once per run and shares the access token with later checks. */
async function accessToken(context: CheckContext): Promise<string | ProbeOutcome> {
  const cached = context.shared.get("access_token");
  if (cached) return cached;
  const supabase = base(context.env["SUPABASE_URL"]);
  const response = await request(context, `${supabase}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: context.env["SUPABASE_ANON_KEY"] ?? "",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      email: context.env["XOS_SYNTHETIC_EMAIL"],
      password: context.env["XOS_SYNTHETIC_PASSWORD"],
    }),
  });
  const bad = expectStatus(response, 200);
  if (bad) return bad;
  const body = (await response.json()) as { access_token?: unknown };
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    return failed("no_access_token");
  }
  context.shared.set("access_token", body.access_token);
  return body.access_token;
}

export const atlasSignIn: CheckDefinition = {
  id: "atlas.sign_in_page",
  component: "atlas",
  requires: ["XOS_ATLAS_URL"],
  budgetMs: 600,
  required: true,
  runbook: `${RUNBOOK}#atlas-or-gateway-unavailable`,
  async probe(context) {
    const response = await request(context, `${base(context.env["XOS_ATLAS_URL"])}/auth/sign-in`);
    const bad = expectStatus(response, 200);
    if (bad) return bad;
    const html = await response.text();
    return /<form[\s>]/i.test(html) ? ok : failed("sign_in_form_missing");
  },
};

export const authSignIn: CheckDefinition = {
  id: "atlas.sign_in",
  component: "atlas",
  requires: ["SUPABASE_URL", "SUPABASE_ANON_KEY", "XOS_SYNTHETIC_EMAIL", "XOS_SYNTHETIC_PASSWORD"],
  budgetMs: 800,
  required: true,
  runbook: `${RUNBOOK}#sign-in-failing`,
  async probe(context) {
    const token = await accessToken(context);
    return typeof token === "string" ? ok : token;
  },
};

export const gatewayHome: CheckDefinition = {
  id: "gateway.home",
  component: "gateway",
  requires: ["XOS_GATEWAY_URL"],
  budgetMs: 600,
  required: true,
  runbook: `${RUNBOOK}#atlas-or-gateway-unavailable`,
  async probe(context) {
    const response = await request(context, `${base(context.env["XOS_GATEWAY_URL"])}/`);
    const bad = expectStatus(response, 200);
    if (bad) return bad;
    const html = await response.text();
    return /<html[\s>]/i.test(html) ? ok : failed("not_html");
  },
};

export const apiDocument: CheckDefinition = {
  id: "api.openapi",
  component: "api",
  requires: ["XOS_ATLAS_URL"],
  budgetMs: 250,
  required: true,
  runbook: `${RUNBOOK}#api-errors-or-latency`,
  async probe(context) {
    const response = await request(
      context,
      `${base(context.env["XOS_ATLAS_URL"])}/api/v1/openapi.json`,
    );
    const bad = expectStatus(response, 200);
    if (bad) return bad;
    const body = (await response.json()) as { openapi?: unknown };
    return typeof body.openapi === "string" && body.openapi.startsWith("3.1")
      ? ok
      : failed("not_openapi_3_1");
  },
};

export const apiRead: CheckDefinition = {
  id: "api.read",
  component: "api",
  requires: [
    "XOS_ATLAS_URL",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "XOS_SYNTHETIC_EMAIL",
    "XOS_SYNTHETIC_PASSWORD",
  ],
  budgetMs: 250,
  required: true,
  runbook: `${RUNBOOK}#api-errors-or-latency`,
  async probe(context) {
    const token = await accessToken(context);
    if (typeof token !== "string") return token;
    const response = await request(
      context,
      `${base(context.env["XOS_ATLAS_URL"])}/api/v1/projects?limit=1`,
      {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      },
    );
    const bad = expectStatus(response, 200);
    if (bad) return bad;
    const body = (await response.json()) as { data?: unknown };
    return Array.isArray(body.data) ? ok : failed("no_data_array");
  },
};

export const realtimeJoin: CheckDefinition = {
  id: "realtime.join",
  component: "realtime",
  requires: ["SUPABASE_URL", "SUPABASE_ANON_KEY"],
  budgetMs: 2000,
  required: true,
  runbook: `${RUNBOOK}#realtime-or-sync-degraded`,
  probe(context) {
    const supabase = base(context.env["SUPABASE_URL"]).replace(/^http/, "ws");
    const key = encodeURIComponent(context.env["SUPABASE_ANON_KEY"] ?? "");
    const url = `${supabase}/realtime/v1/websocket?apikey=${key}&vsn=1.0.0`;
    return new Promise<ProbeOutcome>((resolve) => {
      let settled = false;
      const socket = context.openWebSocket(url);
      const finish = (outcome: ProbeOutcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        resolve(outcome);
      };
      const timer = setTimeout(() => finish(failed("join_timeout")), context.timeoutMs);
      socket.onopen = () => {
        socket.send(
          JSON.stringify({
            topic: "realtime:xos-synthetics",
            event: "phx_join",
            payload: {
              config: { broadcast: { self: false }, presence: { key: "" }, postgres_changes: [] },
            },
            ref: "1",
          }),
        );
      };
      socket.onmessage = (event) => {
        const text = typeof event.data === "string" ? event.data : String(event.data);
        let message: { event?: string; ref?: string; payload?: { status?: string } };
        try {
          message = JSON.parse(text) as typeof message;
        } catch (error) {
          finish(failed(`bad_frame_${error instanceof Error ? error.name : "unknown"}`));
          return;
        }
        if (message.event === "phx_reply" && message.ref === "1") {
          finish(
            message.payload?.status === "ok"
              ? ok
              : failed(`join_${message.payload?.status ?? "unknown"}`),
          );
        }
      };
      socket.onerror = () => finish(failed("socket_error"));
      socket.onclose = () => finish(failed("socket_closed"));
    });
  },
};

export const syncLiveness: CheckDefinition = {
  id: "sync.liveness",
  component: "sync",
  requires: ["XOS_POWERSYNC_URL"],
  budgetMs: 1000,
  required: true,
  runbook: `${RUNBOOK}#realtime-or-sync-degraded`,
  async probe(context) {
    const root = base(context.env["XOS_POWERSYNC_URL"]);
    const live = await request(context, `${root}/probes/liveness`);
    if (live.status !== 200) return failed(`liveness_status_${live.status}`);
    const ready = await request(context, `${root}/probes/readiness`);
    return ready.status === 200 ? ok : failed(`readiness_status_${ready.status}`);
  },
};

export const notificationsReachable: CheckDefinition = {
  id: "notifications.function",
  component: "notifications",
  requires: ["SUPABASE_URL"],
  budgetMs: 800,
  required: false,
  runbook: `${RUNBOOK}#notifications-delayed`,
  async probe(context) {
    // Without the service key the dispatcher refuses before doing any work, which proves the
    // Edge Functions runtime and the function are up without sending anything.
    const response = await request(
      context,
      `${base(context.env["SUPABASE_URL"])}/functions/v1/notification-dispatch`,
      {
        method: "POST",
      },
    );
    return response.status === 401 ? ok : failed(`status_${response.status}`);
  },
};

/** Checks in run order: sign-in runs before the API read that reuses its token. */
export const CHECKS: readonly CheckDefinition[] = [
  atlasSignIn,
  authSignIn,
  gatewayHome,
  apiDocument,
  apiRead,
  realtimeJoin,
  syncLiveness,
  notificationsReachable,
];
