# Observability wiring

`@xos/infra/observability` gives every XOS runtime the same three signals, all redacted before they leave the process:

| Signal          | Where it goes                                                                                  | Module                           |
| --------------- | ---------------------------------------------------------------------------------------------- | -------------------------------- |
| Structured logs | One JSON line per event on stdout, collected by Vercel runtime logs and Supabase function logs | `logger.ts`                      |
| Traces          | OpenTelemetry API spans; the Sentry SDK registers the tracer provider and exports them         | `tracing.ts`, `trace-context.ts` |
| Errors          | Sentry (`@sentry/nextjs` 11.5.0), scrubbed by `scrubEvent`, and the structured log             | `errors.ts`                      |
| Correlation     | W3C `traceparent` and `x-request-id`, continued from the caller and echoed on every response   | `http.ts`                        |

The modules have no runtime dependencies and import each other with explicit `.ts` extensions, so Node (Atlas, Gateway), the Next.js Edge runtime and Deno (Supabase Edge Functions) load the same files.

## Redaction rules

- **Keys.** A field whose normalized name is a credential or personal data is replaced with `[redacted]` at any depth: passwords, tokens, API keys, cookies, authorization, email, phone, names, street address, postal code, birth date, tax, national and government identifiers, bank and card numbers, IP address, latitude and longitude, medical fields, free-text notes and the user agent. The list is `EXACT_KEYS` and `KEY_SUFFIXES` in `src/redact.ts`.
- **Values.** Every string is scanned for JWTs, bearer and basic credentials, `xos_live_` and Stripe keys, secrets in query strings, emails, SSNs, card numbers that pass the Luhn check, E.164 and North American phone numbers, and IPv4 and IPv6 addresses.
- **URLs.** Paths are logged without their query string or fragment.
- **Kept.** UUIDs (org, person, request ids), route templates, status codes, durations. They are pseudonymous and needed for incident response.
- **Sentry.** `scrubEvent` keeps only the user id, drops cookies, the query string, the request body, the server name and every header except content negotiation and correlation headers.

## Dependencies to approve (orchestrator)

All are already pinned in ADR 0001; none is installed yet.

| Workspace      | Package              | Version       | Why                                            |
| -------------- | -------------------- | ------------- | ---------------------------------------------- |
| `apps/atlas`   | `@opentelemetry/api` | 1.9.1         | `trace.getTracer("atlas")` passed to `observe` |
| `apps/atlas`   | `@sentry/nextjs`     | 11.5.0        | Error sink and OpenTelemetry tracer provider   |
| `apps/atlas`   | `@xos/infra`         | `workspace:*` | This package                                   |
| `apps/gateway` | `@opentelemetry/api` | 1.9.1         | Same as Atlas                                  |
| `apps/gateway` | `@sentry/nextjs`     | 11.5.0        | Same as Atlas                                  |
| `apps/gateway` | `@xos/infra`         | `workspace:*` | This package                                   |

`pnpm-workspace.yaml` needs `- infra` under `packages` so the apps can depend on `@xos/infra` and `pnpm verify` runs this package's lint, typecheck and tests. Both apps add `@xos/infra` to `transpilePackages`.

## Atlas (owner A06)

`apps/atlas/lib/observability.ts`:

```ts
import * as Sentry from "@sentry/nextjs";
import { trace } from "@opentelemetry/api";
import { createObservability } from "@xos/infra/observability";

export const observability = createObservability({
  service: "atlas",
  env: process.env,
  tracer: trace.getTracer("atlas"),
  errorSink: Sentry,
});
```

`apps/atlas/instrumentation.ts` gains Sentry initialization and the request error hook:

```ts
import * as Sentry from "@sentry/nextjs";
import { createOnRequestError, scrubEvent } from "@xos/infra/observability";

export async function register(): Promise<void> {
  if (process.env["NEXT_RUNTIME"] === "nodejs") {
    const { env } = await import("./lib/env");
    env();
  }
  Sentry.init({
    dsn: process.env["SENTRY_DSN"],
    environment: process.env["VERCEL_ENV"] ?? "development",
    release: process.env["VERCEL_GIT_COMMIT_SHA"],
    tracesSampleRate: Number(process.env["XOS_TRACES_SAMPLE_RATE"] ?? "0.05"),
    sendDefaultPii: false,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
  });
}

export const onRequestError = async (
  ...args: Parameters<ReturnType<typeof createOnRequestError>>
) => {
  const { observability } = await import("./lib/observability");
  return createOnRequestError(observability.errors)(...args);
};
```

`apps/atlas/instrumentation-client.ts` initializes the browser SDK with the same `beforeSend`, `sendDefaultPii: false`, no Session Replay (it records screens that show personal data) and `tracesSampleRate` 0.05. The `SENTRY_DSN` in the browser comes from `NEXT_PUBLIC_SENTRY_DSN`; a DSN is a public ingest address, not a secret.

The public API route handler (`app/api/v1/[[...path]]/route.ts`, owner A04 with A06) wraps the Hono fetch handler:

```ts
import { observe } from "@xos/infra/observability";
import { observability } from "@/lib/observability";

const handle = observe((request) => app.fetch(request), { ...observability, route: "/api/v1" });
export { handle as GET, handle as POST, handle as PATCH, handle as PUT, handle as DELETE };
```

Hono middleware sets the precise route template on the span through `c.req.routePath` when A04 adds it.

The Content Security Policy in `lib/security/headers.ts` adds the Sentry ingest origin (`https://*.ingest.us.sentry.io`) to `connect-src`.

## Gateway (owner A27)

Same three files as Atlas with `service: "gateway"` and `trace.getTracer("gateway")`. Token flow pages must never pass a token into a log field or span attribute; the redactor replaces `token` and `token_hash` query values regardless.

## Supabase Edge Functions (owner A18)

Edge Functions import the module by relative path from the repository (`supabase/functions/_shared/observability.ts` re-exports `../../../infra/observability/src/index.ts`), or through an import map entry when the functions move to their own deploy bundle:

```ts
import { createObservability, observe } from "../_shared/observability.ts";

const observability = createObservability({
  service: "edge.send-notification",
  env: Deno.env.toObject(),
});

Deno.serve(
  observe(
    async (request, { logger }) => {
      logger.info("delivery queued", { notification_id: id });
      return new Response(null, { status: 202 });
    },
    { ...observability, route: "/send-notification" },
  ),
);
```

Without a Sentry Deno SDK (not pinned in ADR 0001) Edge Function errors reach the structured log, which Supabase keeps in its log explorer. `@sentry/deno` is a later decision.

## Environment variables (orchestrator sets them in Vercel and Supabase)

| Name                     | Atlas | Gateway | Edge Functions | Value                                       |
| ------------------------ | ----- | ------- | -------------- | ------------------------------------------- |
| `SENTRY_DSN`             | yes   | yes     | no             | DSN of the Sentry project for that app      |
| `NEXT_PUBLIC_SENTRY_DSN` | yes   | yes     | no             | Same DSN, for the browser SDK               |
| `SENTRY_AUTH_TOKEN`      | build | build   | no             | Source map upload at build; a Vercel secret |
| `XOS_TRACES_SAMPLE_RATE` | yes   | yes     | no             | `0.05` production, `1` preview and staging  |
| `XOS_LOG_LEVEL`          | yes   | yes     | yes            | `info` production, `debug` preview          |
| `XOS_ENVIRONMENT`        | no    | no      | yes            | `staging` or `production`                   |

## Free tier fit

- Sentry Developer plan: one seat, 5,000 errors and 10,000 performance units a month. Two projects (`atlas`, `gateway`) with a 5 percent trace sample stay inside it at staging volume. Spike protection on; no paid add-ons.
- Vercel runtime logs and Supabase logs are included in the current plans.
- Log drains (Section 5: Supabase log drains) are a paid add-on on both Vercel and Supabase. They are listed as a blocked item in the A26 completion report.
