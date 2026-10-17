# Observability wiring

`@xos/infra/observability` gives every XOS runtime the same signals, all redacted before they leave the process:

| Signal          | Where it goes                                                                                        | Module                           |
| --------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------- |
| Structured logs | One JSON line per event on stdout, collected by Vercel runtime logs and Supabase function logs       | `logger.ts`                      |
| Traces          | OpenTelemetry API spans; the Sentry server SDK registers the tracer provider and exports them        | `tracing.ts`, `trace-context.ts` |
| Server errors   | Sentry (`@sentry/nextjs` 11.5.0), scrubbed by `scrubEvent`, and the structured log                   | `errors.ts`, `sentry.ts`         |
| Browser errors  | A 1 KB reporter posts to a same-origin route, which forwards through the server Sentry client        | `browser.ts`, `client-errors.ts` |
| Edge Functions  | `observe` per request; errors to Sentry over HTTP through the envelope sink when `SENTRY_DSN` is set | `edge.ts`, `sentry.ts`           |
| Correlation     | W3C `traceparent` and `x-request-id`, continued from the caller and echoed on every response         | `http.ts`                        |

The modules have no runtime dependencies and import each other with explicit `.ts` extensions, so Node (Atlas, Gateway), the Next.js Edge runtime and Deno (Supabase Edge Functions) load the same files. `@xos/infra/observability` is the server entry; `@xos/infra/observability/browser` is the only module client code may import.

**No DSN, no network.** Every Sentry path is off unless a DSN is set: the apps skip `Sentry.init` and pass no error sink or tracer, and the Edge Functions build no envelope sink. Local runs, tests and CI make no request to Sentry; errors reach the structured log only.

## Redaction rules

- **Keys.** A field whose normalized name is a credential or personal data is replaced with `[redacted]` at any depth: passwords, tokens, API keys, cookies, authorization, email, phone, names, street address, postal code, birth date, tax, national and government identifiers, bank and card numbers, IP address, latitude and longitude, medical fields, free-text notes and the user agent. The list is `EXACT_KEYS` and `KEY_SUFFIXES` in `src/redact.ts`.
- **Values.** Every string is scanned for JWTs, bearer and basic credentials, `xos_live_` and Stripe keys, secrets in query strings, emails, SSNs, card numbers that pass the Luhn check, E.164 and North American phone numbers, and IPv4 and IPv6 addresses.
- **URLs.** Paths are logged without their query string or fragment.
- **Kept.** UUIDs (org, person, request ids), route templates, status codes, durations. They are pseudonymous and needed for incident response.
- **Sentry.** `scrubEvent` keeps only the user id, drops cookies, the query string, the request body, the server name and every header except content negotiation and correlation headers. `sendDefaultPii` is off everywhere. There is no Session Replay anywhere: it records screens that show personal data.

## Server runtimes (Atlas and Gateway)

Both apps depend on `@sentry/nextjs` 11.5.0, `@opentelemetry/api` 1.9.1 and `@xos/infra` (`workspace:*`), and list `@xos/infra` in `transpilePackages`.

`apps/<app>/lib/observability.ts` builds the process's logger, error reporter and tracer. The error sink and tracer exist only when a DSN is configured:

```ts
export const sentryEnabled = sentryDsn(process.env) !== undefined; // SENTRY_DSN ?? NEXT_PUBLIC_SENTRY_DSN

export const observability = createObservability({
  service: "atlas",
  env: process.env,
  tracer: sentryEnabled ? trace.getTracer("atlas") : undefined,
  errorSink: sentryEnabled ? Sentry : undefined,
});
```

`apps/<app>/instrumentation.ts` starts the server client on the Node and Edge runtimes and exports the request error hook:

```ts
export async function register(): Promise<void> {
  // ...environment validation...
  const options = sentryInitOptions("atlas", process.env); // undefined without a DSN
  if (options) Sentry.init(options);
}

export const onRequestError = async (...args) => {
  const { observability, flushErrors } = await import("./lib/observability");
  await createOnRequestError(observability.errors)(...args);
  await flushErrors();
};
```

`sentryInitOptions` sets `dsn`, `environment` (`XOS_ENVIRONMENT`, `VERCEL_ENV` or `NODE_ENV`), `release` (`VERCEL_GIT_COMMIT_SHA`), `tracesSampleRate` from `XOS_TRACES_SAMPLE_RATE` (default 0.05, out-of-range values fall back to it), `sendDefaultPii: false`, and `scrubEvent` as both `beforeSend` and `beforeSendTransaction`. `flushErrors` waits up to 2 seconds for queued events, so a serverless instance frozen after the response loses none.

The public API route handler (`apps/atlas/app/api/v1/[...path]/route.ts`) wraps the Hono fetch handler with `observe` under the route `/api/v1`, and the Hono app's `onError` reports every 500 through `observability.errors` with its request id. Hono middleware can set the precise route template on the span through `c.req.routePath` later.

Gateway token flow pages must never pass a token into a log field or span attribute; the redactor replaces `token` and `token_hash` query values regardless.

## Browser errors, without the Sentry browser SDK

The Sentry browser SDK costs about 30 KB gzip on every page. The route JavaScript budgets of ADR 0027 leave 1 to 3 KB of headroom on the pages over budget, so the browser SDK is not installed, and a check enforces that (below). Browser errors take this path instead:

1. **Reporter** (`browser.ts`, about 1 KB gzip, no imports). `apps/<app>/instrumentation-client.ts` installs it before hydration with the endpoint, the app's route templates (`lib/client-error-routes.ts`) and the release (`NEXT_PUBLIC_XOS_RELEASE`, inlined from `VERCEL_GIT_COMMIT_SHA` by `next.config.ts`). It listens for `error` and `unhandledrejection` on `window`, ignoring errors from other origins and opaque `Script error.` events. Every `error.tsx` boundary (and the shared segment error components) calls `reportClientError(error)`; a boundary error that carries a `digest` came from a server render, which `onRequestError` already reported, so it is skipped.
2. **Payload.** `message` (`Name: message`, at most 300 characters), `stack` (frame lines only, at most 15), `route` (the template, such as `/[org]/p/[projectKey]/work`, never the concrete path), `source` (`window`, `promise` or `boundary`), `release`, and `userId` only when the page has called `setReporterUser` with the person's UUID. Before it leaves the browser the reporter strips query strings and fragments, JWTs, bearer and basic credentials, emails, runs of 32 or more token characters and, in the message, digit runs that look like phone or account numbers. Form values, cookies, headers and the URL are never read. At most five distinct reports leave per page load, each once.
3. **Delivery.** `navigator.sendBeacon` to `/api/client-errors` on the same origin, so the Content Security Policy's `connect-src 'self'` already covers it and no Sentry origin is added. Nothing in the browser calls Sentry.
4. **Route** (`apps/<app>/app/api/client-errors/route.ts`, built on `createClientErrorHandler` in `client-errors.ts`). In order: 403 unless the `Origin` header is the request's own origin or the site origin (Gateway's custom domains are their own origin); 413 over 8 KB; 429 past 10 reports a minute per caller or 300 per server instance (in-memory fixed window, keyed by the forwarded address, which is never logged); 400 unless the strict zod schema (`lib/client-errors.ts`) accepts it, which refuses unknown fields, a route with a query string and a user id that is not a UUID. The message and stack then pass the server redactor again, and the error is reported through `observability.errors` as a `BrowserError` tagged `runtime:browser`, `source`, `route` and `browser_release`, with the user id as the Sentry user. Without a DSN it reaches only the structured log. The route answers 204 and echoes nothing.
5. **Enforcement.** `pnpm --filter @xos/testing budget:js` fails when any script under `apps/<app>/.next/static` carries the Sentry SDK (`packages/testing/src/client-chunk-audit.ts`), so the `route-js-budget` CI job catches a browser SDK on the next push.

What this gives up against the browser SDK: breadcrumbs, browser performance traces, automatic source map resolution of minified browser frames, and Session Replay (which stays off by policy). Frames arrive minified; upload of source maps is a separate decision (see Environment variables).

## Supabase Edge Functions

The Edge runtime loads only files inside `supabase/functions`, so the functions take these modules from the vendored platform bundle (`supabase/functions/_vendor/xos-platform.js`, generated by `pnpm --filter @xos/platform bundle:edge` from `packages/platform/edge/entry.ts`, which exports `observeEdgeFunction`, `createObservability` and `observe`).

`supabase/functions/_shared/runtime.ts` `serve()` wraps every handler with `observeFunction` from `_shared/observability.ts`, which calls `observeEdgeFunction` with the function name from the first request's URL:

- `observe` under the service `edge.<function>` and the route `/<function>`: the caller's trace continues, the logger carries the request and trace ids, one completion record is written per request, and `traceparent` and `x-request-id` are echoed.
- An unexpected error becomes the generic 500 problem of A22-013 (`internalErrorResponse`, logged with the request id). When the function has a `SENTRY_DSN` secret, one scrubbed event also goes to Sentry through `createSentryEnvelopeSink`: a dependency-free client of Sentry's envelope endpoint (`https://<host>/api/<project>/envelope/`) that runs `scrubEvent` and redacts the extra fields before sending, and the request waits up to 2 seconds for it. A send failure is logged as a warning and never changes the response.
- Without the secret no sink is built and nothing leaves the function but the log.

No Sentry Deno SDK is pinned in ADR 0001; the envelope sink covers errors, and Edge Function tracing stays in the structured log. `@sentry/deno` remains a later decision.

## Environment variables (owner sets them in Vercel and Supabase)

| Name                     | Atlas    | Gateway  | Edge Functions | Value                                                                                     |
| ------------------------ | -------- | -------- | -------------- | ----------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SENTRY_DSN` | yes, set | yes, set | no             | DSN of the Sentry project `xos-atlas` or `xos-gateway`; the server falls back to it       |
| `SENTRY_DSN`             | optional | optional | secret         | Overrides the server DSN; for Edge Functions, the DSN of their project (owner sets later) |
| `XOS_TRACES_SAMPLE_RATE` | yes      | yes      | no             | `0.05` production, `1` preview and staging                                                |
| `XOS_LOG_LEVEL`          | yes      | yes      | yes            | `info` production, `debug` preview                                                        |
| `XOS_ENVIRONMENT`        | no       | no       | yes            | `staging` or `production`                                                                 |
| `VERCEL_GIT_COMMIT_SHA`  | system   | system   | no             | Release on server events and, inlined at build, on browser reports                        |
| `SENTRY_AUTH_TOKEN`      | not used | not used | no             | Only needed if source map upload (`withSentryConfig`) is adopted later                    |

The legacy Sentry project `atlvs` is not used by anything in this repository.

## Free tier fit

- Sentry Developer plan: one seat, 5,000 errors and 10,000 performance units a month. Two projects (`xos-atlas`, `xos-gateway`) with a 5 percent trace sample stay inside it at staging volume. Browser reports are capped at five per page load and 10 a minute per caller, which bounds what a looping page can spend. Spike protection on; no paid add-ons.
- Vercel runtime logs and Supabase logs are included in the current plans.
- Log drains (Section 5: Supabase log drains) are a paid add-on on both Vercel and Supabase. They are listed as a blocked item in the A26 completion report.
