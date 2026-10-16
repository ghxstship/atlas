import type { Connector } from "../../framework/connector.ts";
import { calendarConnector } from "./connector.ts";
import { googleCalendarProvider, microsoftCalendarProvider } from "./providers.ts";
import type { CalendarSource } from "./source.ts";

export * from "./connector.ts";
export * from "./providers.ts";
export * from "./source.ts";

/** The Google Calendar and Microsoft 365 connectors over one calendar source. */
export function calendarConnectors(source: CalendarSource): Connector[] {
  return [googleCalendarProvider, microsoftCalendarProvider].map((p) =>
    calendarConnector(p, source),
  );
}
