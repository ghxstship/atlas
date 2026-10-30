# ADR 0040: Calendar Feeds Served and the Project Inbox Surface

- Status: Proposed (amends ADR 0006)
- Date: 2026-10-20
- Decider: Orchestrator, on A84's proposal (RRR-129, finding A65-018)

## Context

Section 4.6.5 promises calendar feeds per user and per project, and a project inbox. Section 4.5.3 lists the
route `/ical/{feedToken}.ics`, and Section 4.5.8 gives Gateway's Work, Upcoming "a calendar feed". Migration
0550 stored member and project feeds with hashed tokens and a token RPC, project inbox addresses and inbound
mail. Finding A65-018 found that nothing served the route (the sitemap delegated it), no feed could be made,
rotated or revoked from any screen, Gateway's external parties had no feed at all, and no screen showed or
created an inbox address or the mail that arrived.

Two constraints shaped the work. A Next.js segment cannot carry a fixed suffix, so `[feedToken].ics` is not
a valid route file. And calendar clients fetch from shared servers: Google Calendar and Outlook poll many
people's feeds from a few addresses, and keep polling links that were revoked long ago.

## Decision

1. **Sitemap amendment (ADR 0006 item 5).** The `calendar-feed` node keeps the route the spec writes,
   `/ical/{feedToken}.ics`, with `auth: token`. Atlas now serves it, so `DELEGATED` no longer lists it.
   - The handler lives at `app/ical/[feedFile]/route.ts`. It takes the whole file name and answers 404 unless
     the name is `<token>.ics`.
   - `ROUTE_HANDLER_FILES` in `apps/atlas/ia/routes.config.ts` records that file for the node. Gate 15
     (`apps/atlas/test/routes.test.ts`) checks that the file exists and counts it as the node's route file, and
     the route generator writes no page for the node.
   - Gateway serves the same handler as the shell route `/ical/{feedFile}` (`apps/gateway/ia/routes.config.ts`),
     so links Gateway issues stay on Gateway's own host, custom domains included.
   - Both proxies skip `/ical/`. No session is read, refreshed or set for a feed, and calendar apps get no page
     headers.
2. **Tokens.**
   - A token is `xcal_` and 256 random bits in hex. Only its SHA-256 hash is stored. It is shown once, as the
     full link, when a feed is created or rotated.
   - Rotating replaces the token in place and keeps the feed. Revoking stamps `revoked_at` once, never clears
     it, and removes the feed from lists (`deleted_at`).
   - Rotated and revoked hashes go to `private.retired_calendar_feed_tokens` for a year. A calendar still
     polling a dead link gets 404, and the poll does not count as a failed guess.
   - Each membership and each person may hold 20 live feeds.
3. **Rate limits** (all in Postgres, `private.rate_limit_exceeded`, which refuses a read-only call first):
   - 120 fetches an hour per token, from any address.
   - 20 failed lookups in 15 minutes per client. The client is the address the Atlas or Gateway route relays
     from `clientAddress()` (A69-003), scoped under the address that reached PostgREST, `private.request_ip()`
     (A69-002). So clients behind the platform's servers get their own budgets, and a client cannot spend
     another hop's budget.
   - 2000 failed lookups in 15 minutes per reaching address. This bounds a direct caller that invents relayed
     addresses.
   - Residual risk: the relayed address is not signed. A caller that reaches PostgREST directly can split its
     own failure budget up to the per-hop ceiling. With 256-bit tokens this buys no useful guessing. A signed
     relay (a shared secret between the routes and Vault) would close it and is listed as a follow-up.
4. **Scope and visibility.**
   - A member feed shows the member's own shifts and the meetings, milestones and deadlines assigned to them
     in that org.
   - A project feed shows the project's shifts and records the member may see: every shift and record to
     people who read the project's shifts and records, otherwise only their own.
   - A person feed (Gateway) shows what Gateway shows the person across every org: published shifts of their
     engagements and records shared with them, read through `api_external.shifts` and
     `api_external.records`.
   - `api_public.calendar_feed` sets the owner's claims and filters with the same helpers the row level
     security policies use. An ended membership or a deleted person ends the feed.
5. **Events.**
   - Each event keeps the IANA zone its times were typed in. The writer (`@xos/data/ical`) emits `TZID` local
     times and one `VTIMEZONE` per zone, built from the platform's time zone data for the span the events
     cover. A zone the platform does not know falls back to UTC.
   - `UID` is `<row id>@xos`.
   - `SEQUENCE` is the number of whole seconds between the row's creation and its last change, so every
     change and cancellation raises it.
   - Draft shifts and Proposed records are `TENTATIVE`. Canceled shifts and records stay in the feed as
     `CANCELLED`. Milestones and deadlines are points in time, marked free (`TRANSP:TRANSPARENT`).
   - The feed covers 90 days back and 18 months ahead, with at most 2000 events.
   - Lines fold at 75 octets without splitting a character, and TEXT is escaped (RFC 5545 3.1 and 3.3.11).
   - The calendar name comes from `platform.calendarFeeds.feed` in the owner's language.
6. **Logs.** The redactor replaces whatever follows `/ical/` and signed reply local parts
   (`r-<thread>-<person>-<signature>`), on top of A69-008's token prefixes.
7. **Project inbox.**
   - A project has one live address. Project Settings creates it, replaces it (when the old one draws spam)
     or turns it off. An address is never edited, and a disabled address never comes back.
   - The mail shows on the project's Documents tab to people who file documents on the project. Section 4.5.4
     fixes the tab list, so the inbox gets no tab of its own.
   - Filing turns verified mail into a Document record of the project, titled as the coordinator chooses or
     by the subject. It may name one record of the project the coordinator can open. The subject, sender and
     text are posted as a comment on the document and on that record.
   - Mail whose sender did not verify (DKIM) is never filed, only discarded.
   - Discarding keeps the mail with who discarded it, when and why.
   - The audit ledger records every address change and every filing or discard. It records updates only, so
     mail bodies never enter it.
   - The pipeline is unchanged: the provider posts to `inbound-email` with `XOS_INBOUND_SECRET`, and
     `app.receive_inbound_email` lands the mail.
8. **API (additive, ADR 0014).**
   - `calendarFeeds.rotate`.
   - `personCalendarFeeds` with list, get, create, rotate and delete. Delete revokes the feed.
   - `projectInboxes` with list, get, create, replace and disable.
   - `inboundMessages` with list, get, file and discard.
   - `CalendarFeedToken` now lives in `catalog/modules/parts/a84.ts`. Its document shape is unchanged.

## Consequences

- **OWNER:** choose the receiving domain and add its MX records. Then set `XOS_INBOUND_DOMAIN` on the Edge
  Functions and on the `atlas` Vercel project (`infra/runbooks/production.md`, Email). Until then inbox
  addresses show only their local part, and no mail arrives.
- Attachments of inbound mail are not copied onto the filed document yet. `app.inbound_message_attachments`
  exists, but the pipeline does not write it.
- Follow-ups: a signed relay of the client address (item 3), and attachments on filed mail.

## Amendment (2026-10-23): Resend's inbound mail

ADR 0033 decision 60 chose Resend's inbound mail on `inbound.ghxstship.tech`, if it met the requirements of item 7. It
does (RRR-139, migration 1651), wired two ways differently from the generic pipeline:

- **Signed, metadata-only webhook.** Resend posts an `email.received` event signed the Svix way. `inbound-email`
  verifies it with `RESEND_INBOUND_WEBHOOK_SECRET` over the raw body, refusing a timestamp more than five minutes off,
  then reads the message from Resend's Receiving API with `RESEND_RECEIVING_API_KEY`, a full-access key, since that API
  refuses sending-only keys. The message then goes through `receiveInbound` and `app.receive_inbound_email` unchanged.
  The bearer path with `XOS_INBOUND_SECRET` stays for a provider that posts a parsed message, such as a self-hoster's.
- **DKIM** is Resend's own verdict, `authentication.dkim`, computed by its receiving server; only `pass` verifies.
- **Recipients** come from To, Cc, Bcc and the forwarded-for addresses, so forwarded and blind-copied mail finds its
  inbox. Mail for no address on the inbound domain is ignored before any call to Resend, and so is mail for an address
  with no open inbox and no valid reply signature: `app.inbound_email_org` (migration 1651) makes the same lookups as
  `app.receive_inbound_email` and returns the org it would file under.
- **The raw message** is kept in the private `inbound-mail` bucket as `<org id>/resend/<email id>.eml`, because Resend
  keeps a received message for 30 days and inbound mail is kept two years. The org prefix is how every other object is
  named, so an org purge (`private.org_storage_objects`) finds the file by its name, with or without a row pointing to
  it. It is stored only once the database has taken the message, or holds it from a delivery whose upload failed. A
  message over 50 MiB, the bucket's limit, records `resend:<email id>` and is filed without its raw copy.
- **Bounds.** On either path a body over 100,000 characters is cut, a sender address over 320 characters ignored, a
  Message-ID over 998 bytes replaced by a digest the per-org index can hold, and NUL and unpaired surrogates removed
  from every field, as are character references to them in an HTML-only body. So the database never refuses a message
  that the provider would then retry for a day.

Follow-ups: when retention deletes a message's row after two years, its raw file stays in the bucket until the org is
purged, because SQL cannot delete storage objects (a Storage API sweep by age, as for sandboxes, would remove it); and
attachments on filed mail, which Resend's Attachments API serves.

## Amendment (B7, ADR 0146): named feeds, content, audiences and cues

The owner approved the deferred parity themes on 2026-10-28; package B7 (RRR-231, gap G-50) amends items 4 and 5.

- **Item 4, scope and visibility.** A feed has a name and saved sources (Shifts, Meetings, Milestones, Deadlines,
  Cues; none saved serves the first four, so every 4.0 feed is unchanged). A project feed may follow one audience
  (named people, one team or one canon department) and one show department; shifts and records are kept by the shared
  audience rule (`private.schedule_audience_*`, 2961) after the owner's reach, so a filter never widens it. Cues appear
  on a project feed only for owners who read the project's run of show, and on a person feed exactly as
  `api_external.cues` shows them.
- **Item 5, events.** A cue is an event titled "run · label" at its planned time, ending after its duration, in the
  project's zone, TENTATIVE while its start is to be confirmed, with a sequence that follows the cue, its run and the
  filtered call, and the call's instruction in its description. The calendar name is the feed's name when it has one,
  else `platform.calendarFeeds.feed` as before.
