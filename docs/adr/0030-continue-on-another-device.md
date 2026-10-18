# ADR 0030: Continue on Another Device and Actionable Push

- Status: Accepted
- Date: 2026-10-18
- Decider: A45 (RRR-89), for the orchestrator

## Context

Section 11.10 item 13 asks every Atlas and Gateway page to offer a QR code that opens the same item in Compass, Compass links to open the matching web page, and universal links across all three shells. Journey 58 covers it. Journey 57 asks a Producer to approve a timesheet from a push notification without opening the record. Before this ADR:

- `compass://r/{recordKey}` only bounced to a web URL that lacked the org, so it never resolved.
- No server-side push sender existed; only email was dispatched.
- `act_on_notification` decided only `approval_instances`.
- A submitted timesheet notified nobody.

The production domains of Atlas and Gateway, and the Apple and Android signing identities, are owner decisions not yet made.

## Decision

1. **One link module.** `@xos/ia/handoff` is pure TypeScript shared by Atlas, Gateway, Compass and the tests. It builds and reads every form of a handoff link.

   | Item               | Web page                  | Compass scheme link           | Compass route        |
   | ------------------ | ------------------------- | ----------------------------- | -------------------- |
   | Record             | `/{org}/r/{key}`          | `compass://r/{key}?org={org}` | `/r/{key}?org={org}` |
   | Gateway engagement | `/work/engagements/{key}` | `compass://e/{key}`           | `/e/{key}`           |
   - A record is named by its display key `{project_key}-{record_number}` (`app.record_display_key`). An engagement is named by its Gateway display key.
   - The org slug travels with a record key, because the key is unique only within an org.

2. **What the QR code carries.**
   - Before universal links are configured, it carries the Compass scheme link.
   - Once a shell has `COMPASS_APPLE_TEAM_IDS` or `COMPASS_ANDROID_CERT_SHA256`, it carries the page's own URL. That URL opens Compass where Compass is installed and the web page everywhere else.

3. **Where the control appears.**
   - On the Atlas record page, for all 26 kinds.
   - In the Gateway engagement header, for every engagement tab.
   - The control is "Continue on phone": a popover with the QR code and the link as text.
   - The QR encoder loads with `React.lazy` only when the popover opens.
   - The server passes the copy already translated. The `handoff` namespace stays out of the Atlas client catalog.

4. **Universal link files are generated from configuration.**
   - Atlas and Gateway serve `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` from the same two variables.
   - Atlas claims `/*/r/*`. Gateway claims `/work/engagements/*`.
   - Malformed team ids and fingerprints are dropped, and an unconfigured file answers 404, so nothing ever claims the wrong app.
   - The proxies skip `/.well-known/`.
   - In Compass, `app.config.ts` adds `applinks:` associated domains and verified Android App Links for the hosts named in `XOS_UNIVERSAL_LINK_HOSTS` (`atlas:host,gateway:host`). It restates the paths, and a test keeps them equal to `HANDOFF_PATHS`.

5. **Compass opens records natively where it has a screen.**
   - `app/+native-intent.tsx` maps every link form onto `/r/{key}` or `/e/{key}`.
   - The record screen reads the record under the person's own row level security and shows its key, title, kind, state, project, date and owner.
   - Kinds with a Compass screen (Shift, Inspection, Training; `NATIVE_RECORD_SCREENS`) open that screen in one tap.
   - Every record can still open on Atlas, the web fallback.
   - A record the person cannot read shows only its key and the Atlas link.
   - An engagement opens on Gateway.

6. **Timesheet approval requests (migration 1140).**
   - When a timesheet reaches Submitted, `approval.requested` notifications about the timesheet go to every member with organization reach on `crew.timesheet.approve`. The submitter and the worker are never asked (invariant 18).
   - `act_on_notification` approves or rejects a timesheet through `decide_timesheet`, so every timesheet rule still decides. A rejection needs a reason.
   - Leaving Submitted, by any path, archives every open request for that timesheet.
   - The Atlas Inbox treats these requests as approvable with A and R.

7. **The push contract.** The future push sender sends through the Expo push service:
   - `categoryId: "approval_request"`;
   - `data: { notificationId, kind, subjectTable, subjectId, title }`.

   Compass registers that category with two actions, Approve and Reject (Reject asks for the reason). Both run in the background and require an unlocked device. Compass answers through `notifications.act` (`POST /api/v1/notifications/{id}/act`) with the person's own token and an `Idempotency-Key` of `push-{notificationId}-{action}`, then confirms the outcome with a local notification. Notification permission is asked from the Inbox, never at sign-in. The device registers its Expo push token in `app.push_subscriptions` when push is available.

## Alternatives considered

- **Opening records only on the web from Compass:** rejected. Journey 58 lands on the record in Compass.
- **Always putting https URLs in the QR code:** rejected until the domains exist. Without an apple-app-site-association file on the host, the URL never opens Compass.
- **Acting on the push through the Supabase RPC directly:** rejected. `notifications.act` is the one contract, with idempotency and the problem format.
- **Asking for notification permission at sign-in:** rejected. Section 11.10 asks for context, and the prompt would interrupt every sign-in.

## Consequences

- Journeys 57 and 58 are automated on the iOS simulator:
  - 58: `atlas a45-handoff.spec.ts` decodes the QR pixels, then the Maestro flow `handoff-open-record` opens the decoded link. `apps/compass/scripts/handoff-journey-58.sh` runs both.
  - 57: the Maestro flow `.maestro/journeys/push-approve-timesheet`, run by `scripts/journey-57-push.sh`.
  - Maestro cannot run `xcrun simctl push`, so a local helper delivers the push when the flow asks. The banner's action menu is outside Maestro's hierarchy, so Approve is tapped by its position.
- **Owner steps:**
  - Choose the production hosts.
  - Set `COMPASS_APPLE_TEAM_IDS` (and `COMPASS_ANDROID_CERT_SHA256` once Android signing exists) on Atlas and Gateway.
  - Build Compass with `XOS_UNIVERSAL_LINK_HOSTS`, a signed build with the Associated Domains capability and `ios.appleTeamId`.
  - Build the push sender that claims `Push` deliveries (`app.claim_notification_deliveries`) and posts the contract above to Expo. It needs Expo push credentials, an APNs key, and an `aps-environment` of production in release builds.
- Approving when Compass was terminated depends on iOS launching Compass in the background. The response is replayed from `getLastNotificationResponse` when the JavaScript starts. Long-running cold launches are not covered by the simulator run.
