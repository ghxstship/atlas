# Compass: App Review notes, demo accounts and account deletion

Prepared by A68 (RRR-113). The notes below go into App Store Connect, App Review Information, Notes. `eas metadata:push` uploads them from `store/store.config.json` (`apple.review.notes`); the two copies must stay identical, and `test/store-listing.test.ts` checks that they do.

**Never commit a demo password.** The owner types the demo password into App Store Connect (Sign-In Information) and into Play Console (App access) directly. Nothing in this repository holds it, and the local seed password in `supabase/seeds` is for local stacks only and never works in production.

## Owner values in the notes

| Token                          | What the owner puts there                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `OWNER_DEMO_USERNAME`          | The email of the App Review demo account (also in `apple.review.demoUsername`)                                    |
| `OWNER_DELETION_TEST_USERNAME` | The email of a second review account with the same password, for the reviewer to delete                           |
| `OWNER_REVIEW_CREDENTIAL_CODE` | The code of a valid badge in the review project, for the "Type a code" scan                                       |
| `OWNER_REVIEW_CONTACT_EMAIL`   | The contact email for App Review (also `apple.review.email`, which must stay a valid address, so keep the domain) |
| `OWNER_REVIEW_CONTACT_*`       | First name, last name and phone of the App Review contact                                                         |

## App Review notes

```text
Compass is the field app of XOS, a work platform for live event and production companies. People join through an invitation from their organization (an employer, or a production that books crew) in the XOS web app. Compass has no purchases and no ads.

DEMO ACCOUNT
The user name and password are in the Sign-In Information fields. The account is a field crew member of a demo organization, with a shift today on a project that has no geofence, so you can clock in from anywhere.

SIGN IN
On the sign-in screen tap "Use Password", enter the demo email and password, and tap "Sign In".

WHAT TO TRY
1. Today: tap "Clock In" and allow location. Compass records where the punch happened; it never tracks location in the background. Then try "Start Break", "End Break" and "Clock Out". While you are clocked in, a Live Activity shows the shift on the Lock Screen.
2. Scan: pick "Credential" and an access point, then type OWNER_REVIEW_CREDENTIAL_CODE in "Type a code" to see an allowed scan. The camera scans badge QR codes, asset tags and barcodes; typing a code is for badges that will not scan.
3. More, Incidents, "Report Incident": pick a severity, describe what happened, add a photo with the camera or hold the microphone button to record a voice note, then tap "Send Report" (a critical report asks for a hold).
4. Inbox: approvals and announcements. Compass asks for notification permission here, only when you choose to get notifications.
5. Clock In shortcut: say "Clock in with Compass" to Siri, or find it in the Shortcuts app.

PERMISSIONS
Camera: scanning and incident photos. Microphone: voice notes, only while the button is held. Location while using the app: on-site clock in and the incident location. Face ID: optional app lock (More, Settings, Biometric Unlock). Notifications: approvals and announcements. Compass does not track users and has no third-party analytics or advertising.

ACCOUNT DELETION (guideline 5.1.1(v))
More, Settings, Delete Account. Compass lists the records organizations must keep by law (for example time and pay records), asks for the account email, confirms with Face ID or the passcode, and deletes the account after a two-second hold on "Delete Account". Deletion is refused while the person is clocked in, so clock out first. Signing in with an email link to an address that has no invitation creates an empty account; Compass then shows a screen that explains this and offers Delete Account. Please test deletion with the second account, OWNER_DELETION_TEST_USERNAME, which has the same password as the demo account, so the demo account stays available.

CONTACT
OWNER_REVIEW_CONTACT_EMAIL
```

## Setting up the review accounts (owner, in production)

The production database must not carry the local demo seed (ADR 0033, decision 1), so the review data is made by hand in Atlas, in an organization kept for App Review and Play review:

1. Create an organization, for example "App Review Productions", and a project in it **with no geofence**, so a reviewer anywhere can clock in. Give the project a venue with at least one zone (an access point) for the Scan step.
2. Invite two people with the Field role and set a password for each through the normal invitation: the demo account (`OWNER_DEMO_USERNAME`) and the deletion test account (`OWNER_DELETION_TEST_USERNAME`). Use the same password for both. Store it in the owner's password manager, never in a file.
3. Publish a shift today to the demo account, covering the review window (or a long recurring shift), and accept it once in Compass so Today shows Clock In.
4. Issue a crew badge to the demo account valid for the review window and including the zone; put its code into `OWNER_REVIEW_CREDENTIAL_CODE`.
5. Optionally post an announcement and send one approval request, so Inbox is not empty.
6. Before each submission, sign in with both accounts on a TestFlight build, then clock out, so neither is left on shift (an open shift refuses deletion).

## Google Play: App access

Play Console, App content, App access: choose "All or some functionality is restricted" and add one set of instructions:

- **Name:** Demo field crew account
- **Username:** the demo account email
- **Password:** typed in Play Console only
- **Any other information:** "Tap Use Password on the sign-in screen. The project has no geofence, so Clock In works anywhere. To see an allowed scan, open Scan, pick Credential and an access point, and type the badge code `OWNER_REVIEW_CREDENTIAL_CODE` in Type a code."

## In-app account deletion (Apple 5.1.1(v), Google Play account deletion)

SIM-004 added deletion to Compass; A68 re-checked it on 2026-10-20 against the `xos4-a68` stack (migrations and demo seed of main 7ccd1fd9, Compass Release build on an iOS 26.5 simulator):

- **Where:** More, Settings, Delete Account (`app/settings/delete-account.tsx`; Settings, Account opens it too). A sign-in with no organization or engagement lands on a screen that offers Delete Account too (`identity-failed-delete-account` in `app/_layout.tsx`), so every account Compass can open can be deleted.
- **Flow:** the preview (`app.account_deletion_preview`) lists blockers (legal hold, on shift, sole owner) and what organizations keep and why; the person types the account email, passes Face ID, Touch ID or the passcode when the device has one, and holds Delete Account for two seconds; `app.delete_my_account` runs and the confirmation names how many organizations were told; Done wipes the local database and signs out on this device.
- **Evidence:** journey 38 (`apps/compass/.maestro/flows/account-delete.yaml`) passed on the A68 iPhone 17 Pro Max simulator: a throwaway account signed in, landed on the no-organization screen, opened Delete Account, typed its email, held the button, saw "Your account is deleted", tapped Done and was back on the sign-in screen; its `auth.users` row was gone. It passed with three test-only changes in a local copy of the flow, listed in `store/README.md`, Verification; the app needed none.
- **Web path for Google Play:** Play's Data safety form needs a deletion URL that works without the app. `legal/account-deletion.md` is published at `/legal/account-deletion` on Atlas, so the URL is `https://app.OWNER_DOMAIN/legal/account-deletion` once the domain exists.
