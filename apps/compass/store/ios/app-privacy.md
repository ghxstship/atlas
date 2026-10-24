# Compass: App Store Connect App Privacy answers

The answers for App Store Connect, App Privacy, for Compass 4.0.0 (`pro.ghxstship.compass`), mapped to what the code sends off the device. Prepared by A68 (RRR-113) on main 7ccd1fd9. The owner enters them in App Store Connect; `eas metadata:push` does not upload privacy answers. The same data types are declared in the app's privacy manifest (`app.json`, `ios.privacyManifests.NSPrivacyCollectedDataTypes`), and `test/store-release.test.ts` keeps that manifest free of tracking and of purposes other than App Functionality.

"Collect" here means what Apple means: data that leaves the device and is kept longer than needed to serve the request, by GHXSTSHIP or a processor acting for it (Supabase, Expo push, Apple Push Notification service, Firebase Cloud Messaging on Android, Anthropic when Aurora is on). Data that stays on the device (the encrypted offline database, Face ID results, geofence checks before a punch) is not collected.

## Step 1: Data collection

**Do you or your third-party partners collect data from this app?** Yes.

## Step 2: Data types

Select exactly these. Everything not listed is "not collected".

| Apple category | Data type               | Collected | What Compass sends, and where in the code                                                                                                                                                                                                                                                                                             |
| -------------- | ----------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contact Info   | Name                    | Yes       | The account's name, shown in Profile and on everything the person files (`src/data/identity.ts`); a deletion request sends nothing new but erases it                                                                                                                                                                                  |
| Contact Info   | Email Address           | Yes       | The sign-in email (`src/screens/SignIn.tsx`), and the email typed to confirm account deletion (`src/screens/DeleteAccount.tsx`)                                                                                                                                                                                                       |
| Location       | Precise Location        | Yes       | Latitude, longitude and accuracy with each clock punch (`src/domain/clock.ts`, `latitude`, `longitude`, `accuracy_m`) and with each incident report (`src/domain/incidents.ts`). Sampled only while the app is open (`src/runtime/location.ts`)                                                                                       |
| User Content   | Emails or Text Messages | Yes       | Chat messages to coworkers (Workforce chat, `@xos/data/workforce-chat` `sendMessage`)                                                                                                                                                                                                                                                 |
| User Content   | Photos or Videos        | Yes       | Incident and failed-inspection photos taken with the camera, re-encoded without EXIF and uploaded to `field-media` (`src/runtime/media.ts`)                                                                                                                                                                                           |
| User Content   | Audio Data              | Yes       | Voice notes on incident reports, recorded only while the button is held, uploaded to `field-media` as AAC (`src/screens/VoiceNotes.tsx`)                                                                                                                                                                                              |
| User Content   | Other User Content      | Yes       | Clock punches and breaks, shift acceptances and claims, scans (credentials, assets, deliveries), incident reports and the people named in them, inspection results, forms, drawn signatures, surveys, feed reactions and comments, help desk requests, lost and found posts, and Aurora prompts when the organization turns Aurora on |
| Identifiers    | User ID                 | Yes       | The account, person and membership ids sent with every request and recorded on every row the person writes                                                                                                                                                                                                                            |
| Identifiers    | Device ID               | Yes       | A random install id stored in the Keychain and sent with each synced change (`src/runtime/platform.ts`, `deviceId`), and the Expo push token in `app.push_subscriptions` and `app.person_push_devices` (`src/runtime/notifications.ts`)                                                                                               |

Not collected, with the reason:

- **Coarse Location:** Compass never sends a coarse location; every fix it sends is the precise one above.
- **Phone Number, Physical Address, Other Contact Info:** Compass collects none from the person. The crew directory shows coworkers' work phone numbers that the organization entered in Atlas.
- **Health and Fitness:** no health fields in Compass. An incident description is free text (Other User Content). See open question 3.
- **Financial Info, Purchases:** no payments in Compass. Payout and tax details are entered in Gateway, not in the app.
- **Sensitive Info:** none. Face ID and Touch ID results never leave the device.
- **Contacts:** Compass never reads the address book.
- **Browsing History, Search History:** Compass has no browser. Search terms (the crew directory, the handbook) go to the server only to answer that request and are not stored, which Apple does not count as collection.
- **Usage Data (Product Interaction, Advertising Data, Other Usage Data):** no analytics SDK. Read receipts, acknowledgments and the push token's last-seen time are parts of features the person uses, recorded as the features' own data. See open question 2.
- **Diagnostics (Crash Data, Performance Data, Other Diagnostic Data):** Compass ships no crash or performance SDK today. Sentry (ADR 0033, decision 9) covers Atlas, Gateway and the Edge Functions. When Sentry is added to Compass, add Crash Data and Performance Data, linked, for App Functionality, before that build is submitted.
- **Surroundings, Body:** not collected.
- **Other Data:** nothing beyond the types above.

## Step 3: For each collected type

Answer the same three questions the same way for every type in the table:

1. **Purposes:** App Functionality only. Not Third-Party Advertising, not Developer's Advertising or Marketing, not Analytics, not Product Personalization, not Other Purposes.
2. **Is this data linked to the user's identity?** Yes. Everything Compass sends is tied to the signed-in account.
3. **Is this data used for tracking?** No. Compass has no advertising, no data brokers and no `NSPrivacyTracking` domains, and it never asks for App Tracking Transparency.

## The resulting label

- **Data Used to Track You:** none.
- **Data Linked to You:** Contact Info, Location, User Content, Identifiers.
- **Data Not Linked to You:** none.

## Open questions for the owner

1. **Privacy policy facts.** The label must match the published privacy policy (`legal/privacy-policy.md`, a draft under counsel review). The policy's "Website and app usage" row mentions error reports and performance metrics, which Compass does not send yet; counsel may keep that row for the web apps.
2. **Product Interaction.** We answer No: Compass has no analytics, and the activity it records (read receipts, acknowledgments, last seen on a push token) is the content of features. If counsel prefers the cautious reading, add Usage Data, Product Interaction, linked, App Functionality. Nothing else changes.
3. **Health.** Incident reports are free text and may describe injuries. Apple's Health type covers "user provided health or medical data". If organizations use Compass incident reports for injury and first-aid records, consider declaring Health and Fitness, Health, linked, App Functionality. Counsel decides.
4. **Aurora.** Aurora prompts go to Anthropic as a processor only when the organization turns AI features on (`legal/ai-features-notice.md`). They are declared as Other User Content for App Functionality; no extra type is needed.
