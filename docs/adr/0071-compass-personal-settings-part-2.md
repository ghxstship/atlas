# ADR 0071: Compass Preferences, Notifications, Out of Office and Work Details

- Status: Accepted
- Date: 2026-10-24
- Decider: A111 (RRR-156) took the decisions below for part 2 of Compass's native settings, after A110 (RRR-155, ADR 0070) drew the section list and the identity sections

## Context

S4.5.6-44 asks for one set of personal settings shown in Atlas, Gateway and Compass. Before A111, Compass opened Gateway for Preferences, Accessibility, Notifications, Out of Office and Work Details, and it edited only its own device settings. S4.3-15 part 3 asks for Compass notification preferences: categories by channel and quiet hours, saved by the calls Atlas and Gateway use (ADR 0056 left this part to A111).

Atlas and Gateway keep these settings in different places:

- **Registered personal settings** (`app.personal_setting_values`, migration 0850): the language, time zone, date format, units, start page, accessibility, out of office and work phone. Gateway shows every setting the registry puts on a page.
- **A member's notifications, per org** (migration 1362): the category-by-channel matrix with the org's defaults and mandatory categories, quiet hours read in a time zone, and the email digest. Consent to texts comes from migration 1366. Atlas shows these on Me, Notifications.
- **A person's own notifications** (migrations 1131 and 1461): Email and Push for each party category, and quiet hours for notifications from orgs the person is not a member of. Gateway shows these on Settings, Notifications.
- **Work Details** (migration 1340): sizes, needs, the travel profile, emergency contacts, the passport, loyalty programs and shares. They are owner-only rows, and the passport number is encrypted.

## Decision

1. **The registry decides what Preferences, Accessibility and Out of Office show.**
   - Each screen shows every setting whose registry page is its section, in registry order, with the registry's choices and labels. Work Details also shows the work phone.
   - The theme is the one exception. It stays on Compass's own Settings screen, beside Sunlight, which is a device theme only. That screen already writes `me.theme`.
   - Each value shows where it comes from and whether the org locked it, as Gateway says it. A locked value cannot be changed.
   - A deferred setting says it is saved but not in effect yet.
   - Two notes say what Compass itself does without the person's own value. The person's calendar is the phone's time zone (A71). The phone's language stays until the person or their org chooses one (A65-001).

2. **Notifications has two parts, each matching the shell that owns it.**
   - _In your organizations_ is shown to members only. The person picks an org when they have more than one. The part shows Atlas Me's matrix for that org, with its locks, then quiet hours with their zone and the digest, then consent to texts.
   - _From other organizations_ is shown to everyone. It holds Gateway's party categories by Email and Push, and the person's own quiet hours.
   - The email digest belongs to the member part. The digest is a membership setting (`app.notification_settings`), and `private.notify` digests only a member's email. No person-level digest exists for the other part.

3. **A category offers only the channels its kinds reach.** Compass works these out from the generated notification registry (`reachedChannels`), by the rule of A104's `categoryChannels`. A104 had not merged when A111 was built. Once it merges, Compass can call A104's helper, with no change to what it shows.

4. **What saves offline, and how.** Compass follows A110's pattern:
   - What a section read is kept in a device-local table: `_me_personal_settings`, `_me_notification_matrix`, `_me_notification_settings`, `_me_party_preferences` and `_me_quiet_hours`. Each change queues with its optimistic row, and a fresh read keeps any row a queued write still owns.
   - These changes queue as the RPCs Atlas and Gateway call, with the same arguments:
     - `set_personal_setting` and `clear_personal_setting`;
     - `set_my_notification_preferences`, with one choice per switch;
     - `set_my_notification_settings`;
     - `set_my_quiet_hours`.
   - Gateway writes a party preference to its table directly. A queued one goes through a new uploader route, which runs Gateway's own function (`setMyNotificationPreference`) when the queue sends it.
   - The unit tests compare each queued call with the call the shared data function makes.
   - A queued `clear_personal_setting` now applies to the settings Compass applies, as a queued set does. It removes the value, so Compass falls back to what it does without one until the next read shows what the person inherits.

5. **What never queues.**
   - _Consent to texts_ is recorded online only. It is express consent, given when the person reads the wording (TCPA, Section 14.5). Offline, its switch is disabled and says why.
   - _Work Details_ save online only and are never kept on the phone. Dietary and accessibility needs are health information, and emergency contacts are other people's details. The forms use the parsers Atlas and Gateway share (`@xos/data/work-details-forms`) and the same repository functions.

6. **Work Details in Compass covers the field basics.** Compass edits the work phone, uniform sizes, dietary and accessibility needs, the travel profile and emergency contacts. The passport opens in Gateway: its number needs a step-up and an audited reveal. Loyalty programs, sharing with engagements and the access log also open in Gateway. The Profile keeps showing contacts and sizes read-only, and its button now opens the native Work Details screen.

## Consequences

- A member who changes a channel or quiet hours in Compass sees the same values in Atlas Me and in Gateway, because Compass writes the same rows. The Maestro flow `settings-notifications` reads them back from the server as Atlas and Gateway read them.
- Each section opens offline after being opened once online. A change made offline shows at once and waits in the offline queue, which describes it by its kind.
- Compass now depends on `@xos/schemas` for the notification and settings registries.
- When A104 merges, `reachedChannels` should give way to its `notificationCategoryChannels`.

## Amendment (2026-10-30, R6a, ADR 0105)

Decision 6 changes: Compass no longer edits uniform sizes or the travel profile. ADR 0102 moved them off the profile,
so each production asks for them on the roster entry, in Project details (R5). Work Details in Compass edits the work
phone, dietary and accessibility needs and emergency contacts, and says where the sizes went. The Profile shows the
contacts only.
