import { installClientReporter } from "@xos/infra/observability/browser";
import { CLIENT_ERROR_ROUTES } from "./lib/client-error-routes";

/**
 * Runs in the browser before Gateway hydrates. Installs the error reporter (ADR 0025) in place of
 * the Sentry browser SDK, which the route JavaScript budget cannot carry: uncaught errors and
 * unhandled rejections go to /api/client-errors as a minimal, scrubbed payload. No Session Replay,
 * no browser tracing, and no request to Sentry from the browser.
 */
installClientReporter({
  endpoint: "/api/client-errors",
  routes: CLIENT_ERROR_ROUTES,
  release: process.env.NEXT_PUBLIC_XOS_RELEASE,
});
