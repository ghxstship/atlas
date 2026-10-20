# Compass store release kit

Everything the App Store and Google Play need for Compass, prepared by A68 (RRR-113) so that once the owner has the accounts, TestFlight and Play internal testing are one command each. The owner's step-by-step commands are in `infra/runbooks/production.md`, Compass store release; the release checklist rows are in `docs/release-checklist.md`, Compass store release. Public submission stays an owner stop point (ADR 0033, decision 30).

Nothing here was sent to Apple, Google or Expo: no account was used and no `eas build` or `eas submit` ran.

## What is where

| File                                        | For                                                                                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `../eas.json`                               | EAS build profiles (development, preview, production) and submit profiles (TestFlight, Play internal track)                                  |
| `../scripts/store-preflight.ts`             | Refuses the store commands while an account value is still an `OWNER_` token or the app icon is missing                                      |
| `store.config.json`                         | The App Store listing for `eas metadata:push`: en-US and es-MX text, keywords, categories, age rating, review contact and notes, screenshots |
| `google-play/listing.json`                  | The Play listing, en-US and es-US, to paste into Play Console (Play has no EAS upload)                                                       |
| `apple/screenshot/<locale>/<display>/*.png` | App Store screenshots: `APP_IPHONE_67` (6.9-inch, 1320 x 2868) and `APP_IPHONE_65` (6.5-inch, 1242 x 2688), en-US and es-MX                  |
| `google-play/<locale>/phone/*.png`          | Play phone screenshots, 1080 x 1920 (9:16), en-US and es-US                                                                                  |
| `review-notes.md`                           | App Review notes, the review accounts to set up, Play App access, and the account deletion check                                             |
| `ios/app-privacy.md`                        | App Store Connect App Privacy answers, mapped to the code                                                                                    |
| `ios/privacy-manifest.md`                   | The privacy manifests, required-reason APIs, purpose strings, and encryption and export compliance                                           |
| `google-play/data-safety.md`                | Play Data safety answers and the other App content declarations                                                                              |
| `permissions.md`                            | Every iOS and Android permission, why it is there, what was removed, and the Android target SDK                                              |
| `age-rating.md`                             | App Store age rating and Play IARC questionnaire answers                                                                                     |

## Owner values

Every value that needs an account or an owner decision is an `OWNER_` token, so `git grep OWNER_ apps/compass` lists what is left, and `pnpm --filter @xos/compass store:preflight ios|android|metadata` names it.

| Token                                                                                                           | Where                                           | What it becomes                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OWNER_ASC_APP_ID`                                                                                              | `eas.json` submit, iOS                          | The numeric Apple ID of the App Store Connect app (App Information, General)                                                                                                                                                                            |
| `OWNER_APPLE_TEAM_ID`                                                                                           | `eas.json` submit, iOS                          | The 10-character team id (developer.apple.com, Membership). Also set as the EAS variable `XOS_APPLE_TEAM_ID`                                                                                                                                            |
| `OWNER_PLAY_SERVICE_ACCOUNT_KEY_PATH`                                                                           | `eas.json` submit, Android                      | Delete the key after uploading the Google service account key to EAS, or give the path of a key file kept outside the repository                                                                                                                        |
| `OWNER_DOMAIN`                                                                                                  | `store.config.json`, `google-play/listing.json` | The production domain (ADR 0033, decision 5): marketing, support, privacy policy and account deletion URLs                                                                                                                                              |
| `OWNER_REVIEW_CONTACT_*`, `OWNER_DEMO_USERNAME`, `OWNER_DELETION_TEST_USERNAME`, `OWNER_REVIEW_CREDENTIAL_CODE` | `store.config.json` review, `review-notes.md`   | App Review contact and the review accounts (`review-notes.md`)                                                                                                                                                                                          |
| `OWNER_SUPPORT_EMAIL`                                                                                           | `google-play/listing.json`                      | The support address shown on Google Play                                                                                                                                                                                                                |
| `assets/icon.png` (a file, not a token)                                                                         | `apps/compass/assets/icon.png`                  | The app icon: 1024 x 1024 PNG with no transparency. There is no Compass icon yet (the design system's app icon is an empty slot), so local builds show a blank icon. `app.config.ts` uses the file once it exists, and a release build stops without it |

`eas.json` uses `requireCommit`, so commit the filled values before building. None of them is a secret. The demo password and every key stay out of the repository.

## Versions and build numbers

`app.json` `expo.version` (4.0.0) is the version people see; `store.config.json` `apple.version` must match it (the preflight checks). Build numbers live on EAS (`cli.appVersionSource: remote`) and the production profile increments them on every build (`autoIncrement`), so nothing in the repository changes per build. To raise the version, change `expo.version` and `apple.version` together. Compass does not use EAS Update (no `expo-updates`), so no profile has a channel; adding over-the-air updates later is its own decision (it adds `expo-updates` and a channel per profile).

## Build profiles

| Profile       | Builds                                                                                                                     | For                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `development` | iOS simulator app and Android debug APK, Debug configuration, JavaScript from Metro                                        | Engineers on a simulator or emulator against a local or staging stack               |
| `preview`     | Release builds for internal distribution: ad hoc on iOS (register devices with `npx eas device:create`), an APK on Android | Stakeholders on staging without TestFlight                                          |
| `production`  | Store-signed release builds (`.ipa`, `.aab`) with the next build number                                                    | TestFlight and the Play internal track, through `release:ios` and `release:android` |

## Environment per profile

Each build profile names an EAS environment of the same name (development, preview, production). The values live in EAS, never in the repository: `EXPO_PUBLIC_SUPABASE_URL`, `EXPO_PUBLIC_SUPABASE_ANON_KEY` (public by design), `EXPO_PUBLIC_ATLAS_URL`, `EXPO_PUBLIC_GATEWAY_URL`, `XOS_UNIVERSAL_LINK_HOSTS`, `XOS_APPLE_TEAM_ID` and the file variable `GOOGLE_SERVICES_JSON`. A preview or production build on EAS stops in `app.config.ts` if a server URL is missing, not https, or local, or the app icon is missing, so a build pointing at a developer's laptop cannot reach testers.

## Screenshots

Taken by A68 on 2026-10-20 from the iOS 26.5 simulator (an iPhone 17 Pro Max for 6.9-inch, an iPhone 11 Pro Max for 6.5-inch), Compass Release build, against the local stack `xos4-a68` reset to the demo seed, signed in as the seeded Demo Field Tech. The demo seed uses fictional people and places only (Northwind Summer Series, Pier Site, "Demo Crew Member"); no real names and no secrets appear. Five screens per locale: Today with Clock In at the venue, Schedule with an open shift to claim, a granted credential scan, an incident report, and the running order with the next cue.

To retake them (for example after a UI change), follow the header of `../scripts/store-screenshots.sh`: it resets your local stack, moves the demo show and an open shift to today (`../scripts/store-screenshots.sql`), runs `../.maestro/store/screenshots.yaml` on both simulators in English and Spanish, and writes the files above. Known gaps it avoids rather than fixes: the empty "Current shift" card after Clock In (A59-022) and countdowns to months-away shifts in hours (A59-028).

In the Spanish incident screenshot iOS underlines "suelta" as a misspelling, because the simulator's keyboard is English; retake it with a Spanish keyboard if that matters. The Play screenshots are the 6.9-inch captures with the iOS status bar cropped off and the edges extended to 9:16. Google Play also needs a 512 x 512 icon and a 1024 x 500 feature graphic, which wait on the brand icon.

## Verification

| Check                                                      | Result                                                                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `eas.json` parses with eas-cli 24.12.0's own reader        | `test/store-release.test.ts`                                                                                                                    |
| `store.config.json` passes eas-cli's metadata validation   | `test/store-listing.test.ts`                                                                                                                    |
| Privacy manifest covers every dependency's declared reason | `test/store-release.test.ts`; the Release build carries `PrivacyInfo.xcprivacy` in the app and in `ClockActivity.appex`                         |
| SQLCipher on iOS (A68-001)                                 | `pod install` reports "using SQLCipher"; `OpenSSL.framework` is embedded                                                                        |
| Android manifest                                           | `expo prebuild -p android`: no `WRITE_SETTINGS`, foreground service or background location; the blocked permissions carry `tools:node="remove"` |
| In-app account deletion (journey 38)                       | Passed on the A68 simulator with the test-only changes below; the account's `auth.users` row was removed                                        |

Journey 38 needed three changes to the test flow, made only in a local copy so as not to collide with the Maestro work in flight (A66). They belong in `.maestro/flows/account-delete.yaml`:

1. iOS 26 shows "Save Password?" over the no-organization screen before the flow waits for it, so answer "Not Now" first, then wait for `identity-failed`; and sign out of a leftover empty account when a run starts on that screen.
2. Tap outside the email field before holding Delete Account. While the field is focused, the screen's scroll view spends the first touch on dismissing the keyboard, so the hold never reaches the button. People see the same thing: the first hold after typing does nothing. Setting `keyboardShouldPersistTaps="handled"` on the screen's scroll view would fix it for them.
3. Maestro's iOS typing stopped after the hyphen in `maestro-delete-...@example.com` in that field; a throwaway address without a hyphen typed fully.

Seen while taking the screenshots, for the Compass owners: the Spanish tab label "Bandeja de entrada" is cut to "Bandeja de e..." in the tab bar; the Schedule screen title is "Agenda" while its tab is "Horario"; a granted credential scan reads "Access granted ·" with nothing after the dot; the Spanish access error says "Compass no pudo leer tu person", with the step name left in English; and the home screen icon is blank until `assets/icon.png` exists.
