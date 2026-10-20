import { calendarFeedName, calendarFeedResponse } from "@xos/data/calendar-feeds";
import { clientAddress, trustedProxyHops } from "@xos/data/client-address";
import { createPublicClient } from "@xos/data/client";
import { isLocale } from "@xos/i18n";
import { createTranslator } from "next-intl";
import { messagesFor } from "@/i18n/request";
import { env } from "@/lib/env";
import { observability } from "@/lib/observability";

/**
 * The calendar subscription feed on Gateway's own host, `/ical/{feedToken}.ics` (Section 4.5.8
 * Work, Upcoming "with a calendar feed"; Section 4.6.5; ADR 0038). The same handler as Atlas's:
 * it takes the whole file name, accepts only `<token>.ics`, calls the token RPC as anon with the
 * client address the trusted proxy appended (A69-003), and shows only what the feed's owner may
 * see. The proxy skips this path, and the redactor drops the token from every log.
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
    clientAddress: clientAddress(
      request.headers,
      trustedProxyHops(process.env["XOS_TRUSTED_PROXY_HOPS"]),
    ),
    links: { gatewayOrigin: config.GATEWAY_SITE_URL },
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
