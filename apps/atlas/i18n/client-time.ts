import { getNow, getTimeZone } from "next-intl/server";

/**
 * The time and time zone the next-intl client provider formats with. Without them, every relative time a client
 * component formats (an invite's expiry on Settings, Members; the plan's dates on Billing and Plan) logs an
 * ENVIRONMENT_FALLBACK error and falls back to the browser's clock and zone, which can differ from the server's
 * render (crawl 4.9). `now` is the request's time, the zone the server formats with.
 */
export async function clientTime(): Promise<{ now: Date; timeZone: string }> {
  const [now, timeZone] = await Promise.all([getNow(), getTimeZone()]);
  return { now, timeZone };
}
