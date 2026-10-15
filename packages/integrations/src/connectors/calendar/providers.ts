import type { SyncContext } from "../../framework/connector.ts";
import { IntegrationError } from "../../framework/errors.ts";
import { callJson, callRaw } from "../../framework/http.ts";
import type { CalendarEvent, CalendarProvider, ChangePage, ProviderEvent } from "./connector.ts";

function token(context: SyncContext): string {
  if (context.credential === null) {
    throw new IntegrationError("credential_required", "The connection has no stored credential.", {
      connectionError: true,
    });
  }
  return context.credential.token;
}

function description(event: CalendarEvent): string | undefined {
  return event.conferencingUri ?? undefined;
}

// Google Calendar -----------------------------------------------------------------------------------------------------

const GOOGLE = "https://www.googleapis.com/calendar/v3";

interface GoogleEvent {
  id: string;
  etag?: string;
  status?: string;
  updated?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

export const googleCalendarProvider: CalendarProvider = {
  provider: "google_calendar",
  label: "Google Calendar",
  async writeEvent(context, calendarId, externalId, event) {
    const base = `${GOOGLE}/calendars/${encodeURIComponent(calendarId)}/events`;
    const body = {
      summary: event.title,
      ...(event.location ? { location: event.location } : {}),
      ...(description(event) ? { description: description(event) } : {}),
      start: { dateTime: event.startsAt, ...(event.timeZone ? { timeZone: event.timeZone } : {}) },
      end: { dateTime: event.endsAt, ...(event.timeZone ? { timeZone: event.timeZone } : {}) },
      extendedProperties: { private: { xos_local_id: event.localId } },
    };
    const written = await callJson<GoogleEvent>(context.http, "Google Calendar", {
      method: externalId === null ? "POST" : "PUT",
      url: externalId === null ? base : `${base}/${encodeURIComponent(externalId)}`,
      token: token(context),
      json: body,
    });
    return { externalId: written.id, version: written.etag ?? null };
  },
  async removeEvent(context, calendarId, externalId) {
    try {
      await callRaw(context.http, "Google Calendar", {
        method: "DELETE",
        url: `${GOOGLE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(externalId)}`,
        headers: { authorization: `Bearer ${token(context)}` },
      });
    } catch (error) {
      // Already gone (404, or 410 which classifies as rejected) is the outcome removal wants.
      if (error instanceof IntegrationError && (error.status === 404 || error.status === 410))
        return;
      throw error;
    }
  },
  async changes(context, calendarId, cursor): Promise<ChangePage> {
    const base = `${GOOGLE}/calendars/${encodeURIComponent(calendarId)}/events`;
    const events: ProviderEvent[] = [];
    let pageToken: string | null = null;
    let syncToken = cursor;
    for (;;) {
      const params = new URLSearchParams({
        showDeleted: "true",
        singleEvents: "true",
        maxResults: "250",
      });
      if (syncToken) params.set("syncToken", syncToken);
      else params.set("timeMin", context.now().toISOString());
      if (pageToken) params.set("pageToken", pageToken);
      let page: { items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string };
      try {
        page = await callJson(context.http, "Google Calendar", {
          method: "GET",
          url: `${base}?${params.toString()}`,
          token: token(context),
        });
      } catch (error) {
        // 410 Gone: the sync token expired. Start a full sync; writes are idempotent, so nothing is lost.
        if (error instanceof IntegrationError && error.status === 410 && syncToken) {
          syncToken = null;
          pageToken = null;
          events.length = 0;
          continue;
        }
        throw error;
      }
      for (const item of page.items ?? []) {
        events.push({
          externalId: item.id,
          version: item.etag ?? null,
          startsAt: item.start?.dateTime ?? null,
          endsAt: item.end?.dateTime ?? null,
          updatedAt: item.updated ?? context.now().toISOString(),
          removed: item.status === "cancelled",
        });
      }
      if (page.nextPageToken) {
        pageToken = page.nextPageToken;
        continue;
      }
      return { events, cursor: page.nextSyncToken ?? syncToken };
    }
  },
};

// Microsoft 365 ---------------------------------------------------------------------------------------------------------

const GRAPH = "https://graph.microsoft.com/v1.0";

interface GraphEvent {
  id: string;
  changeKey?: string;
  lastModifiedDateTime?: string;
  start?: { dateTime: string; timeZone: string };
  end?: { dateTime: string; timeZone: string };
  "@removed"?: unknown;
}

/** Graph returns local date-times without an offset; XOS asks for UTC, so "Z" makes them absolute. */
function graphInstant(value: { dateTime: string; timeZone: string } | undefined): string | null {
  if (value === undefined) return null;
  if (value.timeZone !== "UTC") {
    throw new IntegrationError(
      "provider_malformed_response",
      `Microsoft 365 returned ${value.timeZone} times instead of UTC.`,
    );
  }
  return /[zZ]|[+-]\d\d:\d\d$/.test(value.dateTime) ? value.dateTime : `${value.dateTime}Z`;
}

export const microsoftCalendarProvider: CalendarProvider = {
  provider: "microsoft_365",
  label: "Microsoft 365",
  async writeEvent(context, calendarId, externalId, event) {
    const body = {
      subject: event.title,
      body: { contentType: "text", content: description(event) ?? "" },
      start: { dateTime: event.startsAt.replace(/Z$/, ""), timeZone: "UTC" },
      end: { dateTime: event.endsAt.replace(/Z$/, ""), timeZone: "UTC" },
      ...(event.location ? { location: { displayName: event.location } } : {}),
      ...(event.timeZone
        ? { originalStartTimeZone: event.timeZone, originalEndTimeZone: event.timeZone }
        : {}),
      transactionId: event.localId,
    };
    const written = await callJson<GraphEvent>(context.http, "Microsoft 365", {
      method: externalId === null ? "POST" : "PATCH",
      url:
        externalId === null
          ? `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/events`
          : `${GRAPH}/me/events/${encodeURIComponent(externalId)}`,
      token: token(context),
      json: body,
    });
    return { externalId: written.id, version: written.changeKey ?? null };
  },
  async removeEvent(context, _calendarId, externalId) {
    try {
      await callRaw(context.http, "Microsoft 365", {
        method: "DELETE",
        url: `${GRAPH}/me/events/${encodeURIComponent(externalId)}`,
        headers: { authorization: `Bearer ${token(context)}` },
      });
    } catch (error) {
      if (error instanceof IntegrationError && error.status === 404) return;
      throw error;
    }
  },
  async changes(context, calendarId, cursor) {
    const now = context.now();
    const start = new Date(now.getTime() - 30 * 86_400_000).toISOString();
    const end = new Date(now.getTime() + 365 * 86_400_000).toISOString();
    let url: string =
      cursor ??
      `${GRAPH}/me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta?startDateTime=${start}&endDateTime=${end}`;
    if (!url.startsWith(`${GRAPH}/`))
      throw new IntegrationError(
        "cursor_malformed",
        "The Microsoft 365 delta link is not a Graph URL.",
      );
    const events: ProviderEvent[] = [];
    for (;;) {
      const page: { value: GraphEvent[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string } =
        await callJson(context.http, "Microsoft 365", {
          method: "GET",
          url,
          token: token(context),
          headers: { prefer: 'outlook.timezone="UTC", odata.maxpagesize=200' },
        });
      for (const item of page.value) {
        events.push({
          externalId: item.id,
          version: item.changeKey ?? null,
          startsAt: graphInstant(item.start),
          endsAt: graphInstant(item.end),
          updatedAt: item.lastModifiedDateTime ?? now.toISOString(),
          removed: item["@removed"] !== undefined,
        });
      }
      const next = page["@odata.nextLink"];
      if (next !== undefined) {
        if (!next.startsWith(`${GRAPH}/`))
          throw new IntegrationError(
            "provider_malformed_response",
            "Microsoft 365 sent a next link outside Graph.",
          );
        url = next;
        continue;
      }
      return { events, cursor: page["@odata.deltaLink"] ?? null };
    }
  },
};
