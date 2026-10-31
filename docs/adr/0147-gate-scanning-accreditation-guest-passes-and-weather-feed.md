# ADR 0147: Gate Scanning, Accreditation Checks, Guest Passes and the Weather Feed

- Status: Proposed
- Date: 2026-10-31
- Decider: Owner (parity audit approved 2026-10-28; B8 fast-forwarded 2026-10-30), pending review of this ADR
- Package: B8 (RRR-232), gaps G-68, G-71, G-145, G-147, G-148, G-149 and G-150
- Migrations: `2970_gate_scans.sql` to `2977_weather_holds.sql`, `2978_scan_bucket_union.sql` (the union of R9's and
  P5's scanned buckets, which the stacked merge needs) and `2979_notification_kind_seed.sql`

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
   0203 is applied). It refuses a Revoked denial, a credential revoked or deleted since, a denial older than 15
   minutes, a second override and the holder's own badge (invariant 21). Compass queues it after the denied
   `record_scan`, by the denied scan's client id, and offers it only to a person whose cached
   `app.my_capabilities_on_project` answer holds `credentials.credential.issue`. Denied rows recorded before 2970
   keep no reason: a reason worked out afterwards would be invented.
2. **Exit is never refused.** An Out scan is Granted whatever the credential's state, so nobody is held inside, and it
   ends the person's presence.
3. **Presence and counts are views over a 24-hour window.** `app.zone_presence`, `app.zone_counts_live`,
   `app.muster_list` run as their reader (`security_invoker`), so row level security
   decides who sees whom; presence is per person across the org's credentials, Parking passes are left out, a
   geofenced clock-in counts unless a scan places the person at the same venue, and offline scans are ordered by
   device time. A reader who cannot see a person's newer scan elsewhere may see their last readable zone: the muster
   list errs toward listing. Guest rows need both the guest list (`advancing.packet.read`) and the door check-ins
   (`credentials.scan.write`). The Issued page's checks are not a view: `app.credential_review(ids)` is a definer
   function that answers only credentials the caller can read, because its checks re-read `app.credentials` on other
   projects, which ADR 0016 rule 14 forbids a definer helper to do from a view that scans that table.
4. **Required training blocks issuing.** A category may require a training course or a certification. A course is
   met by a passed, unexpired completion through a membership of the org; a certification by a live, unexpired
   `app.certification_holders` row a verifier recorded, which is how people without a membership meet a
   requirement. `t44_guard_credential_requirements` refuses `credential_training_incomplete` for direct issue,
   `app.issue_allocation` and the API alike; existing credentials are untouched. Because a certification record now
   opens a gate, the holder of one may change only their consent to public verification
   (`certification_holder_verifier_only`): clearing an expiry, changing the dates or restoring a removed record is a
   verifier's job.
5. **One live Access badge per holder, category and window.** `t45_guard_credential_duplicate` refuses
   `credential_duplicate` for a second live credential of the same holder and Access category whose window overlaps.
   Parking categories are exempt, because one person may hold passes for several vehicles. Moving to revoked is
   always allowed; clearing `deleted_at` or a revoked state is checked, since credentials are not in Trash. As a
   result an R7 allocation of an Access category to one person with a quantity of 2 or more refuses its second
   issue with `credential_duplicate`, and the Allocations Issue dialog says so. Same-name holders, other badges on
   the project and bookings on other productions are warnings, never blocks.
6. **Guests get passes, not credentials.** A guest list entry takes a pass type (an Access category of the project),
   a table, a host and an email. The database stamps a random pass code, `GP-` and 10 base32 characters, when the
   guest is approved; the guest-pass document prints it as the scan payload `XOSGP1:<pass code>`, and the door finds
   the guest by it. The host hears when the guest arrives (`guest.arrived`). A party never sets the pass type, table
   or host.
7. **Guest emails are the org's, through its own outbox and suppression list.** `app.guest_email_sends` and
   `app.guest_emails` record each send and recipient. Suppression reuses `app.suppression_list` with the rule
   non-transactional email follows; an unsubscribe adds an Unsubscribe row for every category, once. Every guest
   email is non-transactional, carries the unsubscribe link and `XOS_POSTAL_ADDRESS` (decision 41), and a Pass email
   attaches the A6 guest-pass PDF. The unsubscribe RPC refuses GET and counts only failed lookups; an org queues at
   most 2,000 guest emails a day.
8. **The NWS is a public data source, not a subprocessor.** For US venues with a location, the weather-feed Edge
   Function polls the National Weather Service every 10 minutes from three days before the project starts to the day
   after it ends, sending only the venue's coordinates rounded to 4 decimals and a contact User-Agent. Its readings
   feed the same thresholds as manual readings, but an NWS reading never lowers or clears an alert a Manual reading
   raised. Official alerts are stored as warnings, and a new Severe or Extreme one tells the alert-role people and
   dispatchers. Lightning stays manual. Counsel reviews the Subprocessor List bullet before its next publication.
9. **Holds have their own table.** `app.crisis_alerts` requires a canon emergency code and the canon has no weather
   code, so `app.weather_holds` records a hold and its all-clear, one open hold per project, sent to the alert-role
   people, the dispatchers and everyone present. Queued holds from Compass are idempotent by client id and refused
   when made more than 10 minutes before they arrive, so a hold called offline never goes out late.

## Consequences

- Five new refusal codes on credentials, seven on the guest list and emails, five on weather, each with copy in
  en-US and es-US; the OpenAPI v1 contract grows additively only.
- Four notification kinds (`guest.arrived`, `weather.warning`, `weather.hold`, `weather.all_clear`); the three weather
  kinds bypass quiet hours. The seed moves to 2979.
- Two Edge Functions (`guest-email`, `weather-feed`) and the updated `email-unsubscribe`; they reuse the Vault
  secrets `xos_functions_url` and `xos_worker_key`. `XOS_WEATHER_USER_AGENT` is a deployment setting, not a secret.
- `app.weather_forecast_periods` is a provider cache with hard deletes and no audit trail; `private.weather_feed_runs`
  keeps 90 days.

## Alternatives considered

- **An override column on the denied row.** Rejected: the log is append-only and the denial is a fact.
- **A new override capability.** Rejected: the capability seed is applied, and issuing a badge is the same authority
  as letting its holder in.
- **Guest credentials.** Rejected: guests are not accredited people, have no holder record, and the door already
  checks guests against the list.
- **A guest-only suppression table.** Rejected (review correction C10): the org's suppression list already carries
  bounces, complaints and unsubscribes with a lift path.
