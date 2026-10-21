import appIcon from "@xos/ui/brand/app-icon.svg";
import { OFFLINE_PATH, serviceWorkerScript } from "@xos/ui/pwa";

/**
 * GET /sw.js: the Atlas service worker (Section 4.10, A65-023, ADR 0052), from the shared source in @xos/ui/pwa.
 * Served from the origin root so it controls every page; never cached by the browser's HTTP cache, so a new build's
 * worker is picked up on the next visit.
 */
export const dynamic = "force-static";

export function GET(): Response {
  const script = serviceWorkerScript({
    app: "Atlas",
    version: process.env["NEXT_PUBLIC_XOS_RELEASE"] ?? "local",
    offlinePath: OFFLINE_PATH,
    icon: appIcon.src,
  });
  return new Response(script, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
      "Service-Worker-Allowed": "/",
    },
  });
}
