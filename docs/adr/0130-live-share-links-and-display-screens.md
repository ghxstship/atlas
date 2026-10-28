# ADR 0130: Live Share Links to Saved Views and Run-of-Show Display Screens

- Status: Accepted
- Date: 2026-10-28
- Decider: Owner, through the competitor parity audit approved on 2026-10-28 (package P1, RRR-215)
- Migrations: `2780_live_links.sql`, `2781_live_link_reads.sql`, `2782_live_link_channels.sql`
- Gaps closed: G-28 (live, view-only, no-account links to a saved view, with access code, expiry and regenerate) and
  G-76 (room clock, presenter timer and backstage screens on a revocable link with no sign-in, red on overrun,
  poppable to a second screen)

## Context

Before 4.1 the only no-account link was the file share link of `1380_share_links.sql`: one clean version of one
file, classified like the file and watermarked when Confidential. A saved view (0540, 0641) could be read only by a
member, with their own client. Production teams send schedules to vendors, venues and clients who have no account,
and put the running order on screens backstage and in the room. The parity audit found these in Event Lab (live
schedule share links and Workbooks), Ticket Fairy (backstage now-and-next screens on a private link with no
sign-in), ProductionOS (a room clock on its own link that turns red on overrun and pops out to a second screen) and
LASSO (a shareable speaker timer).

## Decisions

### 1. A new table, not a widened share link

`app.live_links` is its own table. A file share link copies its file's classification, carries watermark rules and
needs an attachment; a live link shows rows that change while it is open, from a saved view or a running order, and
needs a channel and device grants. Widening `app.share_links` would have made `attachment_id` nullable and every one
of 1380's rules conditional. The two share the hashing helpers (`private.share_token_hash`,
`private.share_code_hash`), the code draw, the lockout at 5 wrong codes and the per-address failure limit.

A View link names a saved view and a project; a Display link names a running order, and its project is stamped from
it (registered in the denormalization register as `app.cues.project_id` is). Tokens are `xshv_` (a view) and
`xscr_` (a screen) and 256 random bits; only hashes are stored.

### 2. Only allowlisted Public and Internal columns are exposed

`private.live_view_collections` names the four collections a View link may show (`project/schedule`,
`project/show`, `show/run_of_show`, `show/day_sheets`) and `display` for screens, each with its share capability
(making a link), its read capability (which the creator must keep) and its row caps. `private.live_view_fields`
names every column a link may show, filter, sort or group by. A guard refuses a field whose source column
`private.column_classifications` lists as Confidential or Restricted, and a link whose fields are reclassified later
answers `live_link_reclassified`. A record never shows its owner, accountable person, blocker text, replan reason,
XYZ tag or URID; a cue never shows who called it, its description or its cue calls.

A saved view's query is read at every view. Page parameters with eq (kind and state hold comma-separated lists,
read as "in"), `f.<field>` conditions with eq, ne, lt, lte, gt, gte, contains or is_null, and the saved search are
applied when their field is filterable. A `cf.*` condition, a filter on an unlisted field, an unlisted sort or
grouping, or a project parameter naming another project refuses the link (`live_link_view_unsupported`) instead of
widening it. `month` (a calendar's anchor) and `live` (show mode) are not filters and are ignored. The Schedule
collection applies the Schedule page's datedOnly rule (a start, end or due date). Record search matches titles;
running orders match names; day sheets match the day and the body by ILIKE, although the Day sheets page itself reads
no search on the server. Caps: 500 records, 120 day sheets, 200 running orders with at most 300 cues each and 3000 in
all, 300 cues on a screen, each with a truncated flag.

### 3. Reads act as the creator, with each table's predicate applied explicitly

`api_public.live_view` and `api_public.live_display` switch `request.jwt.claims` to the link's creator, as
`api_public.calendar_feed` does (1410), and stop (`live_link_owner_access`) when the creator is no longer a member of
the org or no longer holds the collection's read capability on the project. They run as their definer, which
bypasses row level security, so each query states its table's read predicate: the project, the read capability,
`deleted_at`, and for day sheets publication. This is the deliberate exception to S11.15-02's "each viewer's
access": a no-account viewer has no access of their own, so the link shows what its creator may show, cut to the
allowlist.

### 4. Every link expires within 90 days and asks for an access code

Section 8.6 requires Internal links to expire, so every link has an expiry after now and within 90 days. A display
link defaults to the end of the day after the show in the project's zone (the org's `locale.time_zone`, then UTC),
clamped to 90 days; a show already past gets a day from now. Section 7.5 invariant 8, as ADR 0033 decision 56 words
it, reads "Token RPCs require a token and an access code", so there is no switch: every link has a 6-digit code,
returned once with the token. The `/open` handlers open a link only on POST, with the code in the form body; a GET
shows the code form.

Only members of the project's org make links (`private.is_member`, as 1380), so a partner org that reaches a project
through `app.project_shares` (1205) never publishes the owner org's data; a read-only org makes none, and revoking
stays possible in it (`private.read_only_exempt_tables`). A view or running order holds at most 20 live links.

### 5. Device grants carry later reads

A correct code earns an `xlgr_` device grant, valid until the link expires or for 7 days, kept in one strictly
necessary HttpOnly cookie, `xos_link_grant`, scoped to the link's path (a name starting `xos_live_` would read as an
API key to the log redactor). Reads need the token and the grant, as 1380's download ticket carries a download.
Regenerating draws a new token, code and channel key and deletes every grant; the old token is kept a year in
`private.retired_live_link_tokens` so a screen left open never counts as a failed guess. A link locked by wrong codes
keeps serving devices that already proved the code, so a stranger cannot blank every screen.

Failures count 20 per relayed address in 10 minutes and 2000 per reaching address in 15. Reads are limited per grant
(1200 an hour) with a per-link ceiling (60000 an hour), so many screens on one link never lock each other out.

### 6. An anonymous private channel that carries pings only

Realtime's publication route (1450) checks each change against the subscriber's JWT, and an anonymous visitor reads
no row. Each link instead has a private broadcast channel, `xlink:<channel key>` (`live:` is taken by
`packages/data/src/live.ts`), that only the database sends to. Statement triggers on records, running orders, cues,
day sheets and saved views, their filters and sorts, send an empty `changed` message; the page rereads through its
token RPC. The key reaches a page only from a successful read. The select policy `xos_live_link_channel_read` on
`realtime.messages` is for the anon role, since screens join with the publishable key: 2060's registry gains a
`roles` column and `private.ensure_realtime_channel_policies` creates each policy for its row's roles, the existing
rules keeping `{authenticated}`. The page debounces pings to one refresh a second and pulls every 15 seconds only
while it is not joined, plus a 60-second safety pull.

### 7. Three display modes

Room Clock shows the project's local time and the running cue's time left; Presenter Timer counts the current cue
down, or up without a duration; Backstage shows now, next and the following three cues with "Running N min late" or
"On time". Overrun turns the timer red and adds "Over by m:ss", so color is never the only signal, and it stays red
until the next cue is called. Keys 1, 2 and 3 switch modes; the screen offers a pop-out window, the Fullscreen API
and a screen wake lock.

### 8. Public pages are minimal

The pages and `/open` handlers call the token RPCs through a cookie-less anonymous client, never the visitor's
session. They never render the link's note, set only the grant cookie, load no product analytics and answer with
`Cache-Control: no-store`, `noindex` and `Referrer-Policy: same-origin`. The screen frame hides the cookie banner,
which would otherwise cover the timer on a TV that nobody can click; with no optional cookie there is nothing to
consent to.

Like 1380's file share links, live links are not bound by an org IP allow-list: 1201 enforces it at the session and
API layers, and a no-account link has neither.

### 9. API parity and capabilities

`/live-links` in the v1 API lists and reads links (token-free) and adds `createView`, `createDisplay`, `regenerate`
and `revoke`, all additive. The anonymous open and reads stay token RPCs, as 1380 documents for share links. No new
capability code is added: links use `schedule.timeline.export`, `work.record.read`, `show.run_of_show.read`,
`show.run_of_show.write` and `show.day_sheet.write`.

## Out of scope

Maps stay deferred (S5-29). Budget, cost report, rooming list and equipment collections, viewer comments, emailing a
link, and Gateway and Compass surfaces are not part of this decision.

## Consequences

- Live links are out of Trash (ADR 0110): a revoked or regenerated link is replaced, never restored.
- A new collection a link may show needs rows in both registries and a review of the columns it exposes.
- Production Realtime must accept the anonymous private-channel join; until it does, screens update on their pull.
