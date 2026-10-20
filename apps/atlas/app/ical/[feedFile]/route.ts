import { calendarFeedName, calendarFeedResponse } from "@xos/data/calendar-feeds";
import { clientAddress, trustedProxyHops } from "@xos/data/client-address";
import { createPublicClient } from "@xos/data/client";
import { isLocale } from "@xos/i18n";
import { createTranslator } from "next-intl";
import { messagesFor } from "@/i18n/request";
import { env } from "@/lib/env";
import { observability } from "@/lib/observability";

/**
 * The calendar subscription feed, `/ical/{feedToken}.ics` (Section 4.5.3 and 4.6.5, sitemap node
 * calendar-feed; ADR 0038). A Next segment cannot carry the `.ics` suffix, so this handler takes
 * the whole file name and accepts only `<token>.ics`. It answers without a session: the token RPC
 * runs as anon with the client address the trusted proxy appended (clientAddress(), A69-003), and
 * shows only what the feed's owner may see. The proxy skips this path, so no session or cookie is
 * read or written here, and the token never reaches a log (the redactor drops `/ical/...`).
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: RouteContext<"/ical/[feedFile]">,
): Promise<Response> {
  const { feedFile } = await params;
  const config = env();
  return calendarFeedResponse({
    db: createPublicClient({ url: config.SUPABASE_URL, anonKey: config.SUPABASE_ANON_KEY }),
    feedFile,
    clientAddress: clientAddress(request.headers, trustedProxyHops(config.XOS_TRUSTED_PROXY_HOPS)),
    links: { atlasOrigin: config.ATLAS_SITE_URL, gatewayOrigin: config.GATEWAY_SITE_URL ?? null },
    calendarName: (feed) => {
      const locale = isLocale(feed.locale) ? feed.locale : "en-US";
      const t = createTranslator({
        locale,
        messages: messagesFor(locale),
        namespace: "platform.calendarFeeds.feed",
      });
      return calendarFeedName(feed, (key, values) => t(key, values));
    },
    ifNoneMatch: request.headers.get("if-none-match"),
    onError: (message) => observability.logger.error(message, { route: "/ical/[feedFile]" }),
  });
}
