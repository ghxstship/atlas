# ADR 0147: Gate Scanning, Accreditation Checks, Guest Passes and the Weather Feed

- Status: Proposed
- Date: 2026-11-06
- Decider: Owner (parity audit approved 2026-10-28; B8 fast-forwarded 2026-10-30), pending review of this ADR
- Package: B8 (RRR-232), gaps G-68, G-71, G-145, G-147, G-148, G-149 and G-150
- Migrations: `6250_gate_scans.sql` to `6257_weather_holds.sql`; merge train 9's `6499_notification_kind_seed.sql` seeds the kinds

## Context

The competitor parity audit found that XOS decides each gate scan in the database but keeps no direction, no reason
for a refusal and no way for a supervisor to let someone in; counts people only at doors; issues badges without
checking training, duplicates or bookings on other productions; gives guests no pass, table or host; cannot email a
guest list; and records weather only by hand. The owner approved closing these gaps on 2026-10-28, with these
limits: XOS never holds funds (no table deposits or minimum spends), maps stay deferred (zones are listed by code and
name), and the AI-drafted induction quiz, anti-passback, lightning networks and paid weather providers stay out.

## Decision

1. **An override is a new scan row.** A supervisor's override is a new Granted In row of `app.access_scans` that names
   the Denied In scan it overrides and why. The log stays append-only, and the denied row keeps its reason.
   `app.override_access_scan` is the only writer (trusted operation `access_scan_override`); it needs
   `credentials.scan_log.read` and `credentials.credential.issue` on the project, so no capability is added (the seed
   0203 is applied). It refuses a Revoked denial, a credential revoked or deleted since, a denial older than 15 minutes,
   a second override and the holder's own badge (invariant 21). Compass queues it after the denied `record_scan`, by the
   denied scan's client id, and offers it only to a person whose cached `app.my_capabilities_on_project` answer holds
   both `credentials.credential.issue` and `credentials.scan_log.read`. The server decides a scan when it uploads, so a
   scan Compass denied offline may upload as Granted; the queued override then refuses `scan_not_denied`, and Compass
   drops it as settled with an informational line, not an error. Denied rows recorded before 6250 keep no reason: a
   reason worked out afterwards would be invented.
2. **Exit is never refused.** An Out scan is Granted whatever the credential's state, so nobody is held inside, and it
   ends the person's presence.
3. **Presence and counts are views over a 24-hour window.** `app.zone_presence`, `app.zone_counts_live`,
   `app.muster_list` run as their reader (`security_invoker`), so row level security decides who sees whom; presence is
   per person across the org's credentials, Parking passes are left out, a geofenced clock-in counts unless the
   person's latest scan at that venue is In, or is an Out later than the punch (a clock-in after the Out means they came
   back), and offline scans are ordered by device time, with a device time past 24 hours placing nobody. A clock-in
   counts by the on-site rule of `app.workforce_directory` (1632: an open time entry clocked in within 24 hours with a
   geofence-verified In punch), placed in the punch's geofence zone. A reader who cannot see a person's newer scan elsewhere may see their
   last readable zone: the muster list errs toward listing. Guest rows come from the guest list itself (Checked In
   within 24 hours), because a bulk check-in (2151) writes no door check-in; they need `advancing.packet.read`, and
   their door and plus-ones `credentials.scan.write`. The muster page and Compass say which sources the reader cannot
   see. The views carry the readable columns an export needs (zone code and name, name, credential number, category
   code, party), because a collection export reads one view (2030) and an evacuation export with blank names is not
   acceptable. `app.people` hides engaged externals (1275), `app.organizations` a counterparty (0205) and
   `app.engagements` a reader without `opportunities.engagement.read`, so names come from two definer helpers that take
   values: `private.presence_person_names` and `private.presence_party_names` answer a reader holding
   `credentials.scan_log.read`, `crew.time_entry.read` or `advancing.packet.read` on the project, and give anyone else
   no name. `private.presence_clock_people` gives time entries' people, ids and not names, for a reader who may not read
   memberships or engagements, so a clock-in never silently drops off the list. Each takes arrays, answers one map, and each view
   calls it once, so the gate runs once per statement: a helper called per row took 33 to 41 seconds at 5,000 rows, past
   the 8-second statement timeout, and would have replaced an evacuation list with an error. It now takes about 0.25
   seconds. A refresh that still fails
   keeps the last list on screen and says so. The views scan none of those tables, as
   ADR 0016 rule 14 asks. `app.zone_counts_live` counts people scanned in;
   it is not a load count and never feeds the permitted-load alerts of `app.occupancy_counters`. The Issued page's
   checks are not a view: `app.credential_review(ids)` is a definer function that answers only credentials the caller
   can read, because its checks re-read `app.credentials` on other projects, which ADR 0016 rule 14 forbids a definer
   helper to do from a view that scans that table.
4. **Required training blocks issuing.** A category may require a published training course or a certification (a Draft
   or Retired course refuses `credential_requirement_course_state`). A course is met by a passed completion through a
   membership of the holder in the course's org, current or ended, whose own `expires_at` has not passed; a
   certification by a live `app.certification_holders` row a verifier recorded, unexpired on the current date in the time
   zone of the category's project, which is how people without a membership meet a requirement. `t44_guard_credential_requirements` refuses `credential_training_incomplete` for
   direct issue, `app.issue_allocation` and the API alike, naming the unmet titles for the API's problem detail; the
   Issue form and the Allocations Issue dialog name them in the reader's language from `app.credential_issue_check`.
   Existing credentials are untouched. Because a certification record now opens a gate, the holder of one may change
   only their consent to public verification (`certification_holder_verifier_only`): clearing an expiry, changing the
   dates, or removing or restoring the record is a verifier's job.
5. **One live Access badge per holder, category and window.** `t45_guard_credential_duplicate` refuses
   `credential_duplicate` for a second live credential of the same holder and Access category whose window overlaps.
   Parking categories are exempt, because one person may hold passes for several vehicles. Moving to revoked is always
   allowed; clearing `deleted_at` or a revoked state is checked, since credentials are not in Trash. Production may
   already hold overlapping live Access credentials, so an update refuses only an overlap the row did not already have:
   the row made live again, or its window widened into another live credential. The refusal names the existing number
   (the Issue form reads it from `app.credential_issue_check`). As a result an R7 allocation of an Access category to
   one person with a quantity of 2 or more refuses its second issue with `credential_duplicate`, and the Allocations
   Issue dialog says so. Same-name holders, other badges on the project and bookings on other productions are warnings,
   never blocks. Bookings are looked for only within the producing org; an open-ended engagement is booked from its
   start on.
6. **Guests get passes, not credentials.** A guest list entry takes a pass type (an Access category of the project), a
   table, a host and an email. The host is checked by `private.guest_host_on_project`, what `app.project_people` lists: a
   current member of the project's org or the person on a live engagement of the project. Its name is its own because
   batch-c's 5941 gave `private.is_project_person` a broader meaning. The Add guest form keeps to seven visible fields
   (name, plus-ones, scope, note, pass type, email, approve); the table and host are set on the guest's own pass form. A
   guest email and a pass code are Confidential, and every path stores the email trimmed and lowercased, refusing a bad
   one with `guest_email_format`. The database stamps a random pass code, `GP-` and 10 base32 characters, when the guest is
   approved; the guest-pass document prints it as the scan payload `XOSGP1:<pass code>`, and the door finds the guest by
   it or by the code as printed. The door list returns the host's name, since door staff may not read people. The host
   hears when the guest arrives (`guest.arrived`), from an after-update trigger on the move to Checked In, so a door
   check-in and a bulk check-in both tell them, once, unless the host checked the guest in. A party never sets the pass
   type, table or host, and the party reads of the guest list return neither the pass code nor the guest's email. A
   guest pass is not a ticket (S17-10): it sells nothing and admits only through the guest list at the door. The guest
   portal (G-70: RSVP, meal, table, self check-in) stays post-launch; the only page a guest opens is
   `/unsubscribe/{token}`.
7. **Guest emails are the org's, through its own outbox and suppression list.** `app.guest_email_sends` and
   `app.guest_emails` record each send and recipient. Suppression reuses `app.suppression_list` with the rule
   non-transactional email follows; an unsubscribe adds an Unsubscribe row for every category, once. Every guest email
   is non-transactional, carries the unsubscribe link and `XOS_POSTAL_ADDRESS` (decision 41), and a Pass email attaches
   the A6 guest-pass PDF, dated by the guest's approval so a retried send carries the same bytes. A row's unsubscribe
   token is signed over its id with the Vault secret 0570 signs with, the same on every claim, so a retry sends the same
   payload under the same idempotency key; nothing about the token is stored. The unsubscribe RPC refuses GET and keeps
   no failure counter: a signed token cannot be guessed and both callers are servers. A provider error loses the
   recipient's address before it is stored. An org queues at most 2,000 guest emails a day. The From names the org,
   which makes the org the sender, while the footer's `XOS_POSTAL_ADDRESS` is GHXSTSHIP's, and XOS stores no org postal
   address: counsel confirms that address satisfies CAN-SPAM's physical-address rule for org-sent guest emails, or names
   the follow-up (an org mailing address setting).
8. **The NWS is a public data source, not a subprocessor.** For US venues with a location, the weather-feed Edge
   Function polls the National Weather Service every 10 minutes from three days before the project starts to the day
   after it ends, sending only the venue's coordinates rounded to 4 decimals and a contact User-Agent. Its readings feed
   the same thresholds as manual readings, but an NWS reading never lowers or clears an alert a Manual reading raised,
   and lowers one it raised itself only down to the level of the hazard's latest Manual reading against the current
   thresholds; a Manual reading below every threshold removes that floor. The floor only holds a standing alert: it never
   raises one. An observation more than 2 hours old is not
   recorded, so an outage never raises a late alert. Heat is the heat index, or the temperature when the NWS gives none,
   so a raised Heat alert can lower in cooler weather. The station, forecast URL and check time are the worker's: a
   person's write refuses `weather_feed_worker_fields`. A 5xx is retried once. Official Actual alerts are stored as warnings, and a Test or Exercise message is not; a CAP Update or Cancel
   references the alerts it replaces, which end. A new Actual Severe or Extreme alert that replaces no recorded warning
   tells the alert-role people and dispatchers once. So does an Actual Severe or Extreme Update none of whose referenced
   warnings was Severe or Extreme, because a Moderate warning told nobody and its escalation must not stay silent; every
   other reference stays silent, and a Cancel never tells anyone. The
   hourly forecast keeps what the endpoint gives: temperature, wind speed, precipitation chance and the short forecast.
   A payload with a malformed time or number refuses `weather_feed_payload`. Lightning stays manual. Counsel reviews the
   Subprocessor List bullet before its next publication.
9. **Holds have their own table.** `app.crisis_alerts` requires a canon emergency code and the canon has no weather
   code, so `app.weather_holds` records a hold and its all-clear, one open hold per project, sent to the alert-role
   people of every level, the dispatchers and everyone present. Queued holds and all-clears from Compass are idempotent
   by client id. A hold made more than 10 minutes before it arrives is still sent, because a late stop-work errs safe:
   it is recorded with its device time and its message says when it was called. A late all-clear is refused
   (`weather_hold_stale`), so nobody goes back out on a stale one.
10. **Trash (ADR 0110).** Every new soft-deletable table is decided by the migration that creates it, which then calls
    `private.sync_trash_tables()`. None enters Trash: `credential_category_requirements` (removed and added again, with
    no title of its own), `guest_email_sends` and `guest_emails` (written only by the queue and the worker),
    `weather_feeds` (turned on and off), `weather_warnings` and `weather_forecast_periods` (the provider's records),
    `weather_message_templates` (edited in place; removing one brings back the default) and `weather_holds` (a safety
    record).

## Consequences

- New refusal codes on scans and credentials, the guest list and guest emails, and weather, each with copy in en-US
  and es-US; the OpenAPI v1 contract grows additively only.
- Four notification kinds (`guest.arrived`, `weather.warning`, `weather.hold`, `weather.all_clear`); the three weather
  kinds bypass quiet hours. The seed moves to 2979.
- Two Edge Functions (`guest-email`, `weather-feed`) and the updated `email-unsubscribe`; they reuse the Vault
  secrets `xos_functions_url` and `xos_worker_key`. `XOS_WEATHER_USER_AGENT` is a deployment setting, not a secret.
- `app.weather_forecast_periods` is a provider cache with hard deletes and no audit trail; `private.weather_feed_runs`
  keeps 90 days.

## Owner's explicit choices

- Override authority is `credentials.credential.issue` (with the scan log), with no new capability.
- Exit is never refused.
- Guest emails are capped at 500 per send and 2,000 per org per day.
- A weather hold queued offline is sent however late it arrives, saying when it was called; a late all-clear is not.
- Counsel confirms `XOS_POSTAL_ADDRESS` satisfies the physical-address rule for org-sent guest emails, or names the
  follow-up.

## Alternatives considered

- **An override column on the denied row.** Rejected: the log is append-only and the denial is a fact.
- **A new override capability.** Rejected: the capability seed is applied, and issuing a badge is the same authority
  as letting its holder in.
- **Guest credentials.** Rejected: guests are not accredited people, have no holder record, and the door already
  checks guests against the list.
- **A guest-only suppression table.** Rejected: the org's suppression list already carries bounces, complaints and
  unsubscribes with a lift path, and a second list would let a person who unsubscribed from one still get email from
  the other.
