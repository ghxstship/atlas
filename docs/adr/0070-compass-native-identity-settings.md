# ADR 0070: Compass Native Identity Settings

- Status: Proposed
- Date: 2026-10-24
- Decider: A110 (RRR-155), trace row S4.5.6-44
- Migrations: none

## Context

Section 4.5.6 asks for one set of personal settings shown in Atlas, Gateway and Compass, and ADR 0006 item 11 has Compass show 14 of the 15 sections (Keyboard Shortcuts is desktop only). Compass Settings showed only its device settings and opened Gateway's `/settings` for everything else, so a crew member on a phone without a laptop could not fix a typo in their name, see where they are signed in, or leave an org. The sitemap already held the 14 routes; nothing drew them.

Compass works offline, and Gateway and Atlas never had to decide which of these changes can wait for a connection. Gateway also has no password form: its Security page manages second factors, passkeys, recovery codes and sessions.

## Decisions

### 1. One section model, native where Compass draws the section

- `apps/compass/src/settings/sections.ts` reads the settings children of the More menu from the generated navigation, so the order and labels are the sitemap's. Each entry opens its Compass screen when its id is in `NATIVE_SECTIONS`, or the same section in Gateway, which serves every personal section at the route Compass uses (`/settings/<section>`).
- A110 makes the identity group native: Profile, Profile Privacy, Account, Security and Organizations. A111 and A112 add their ids to `NATIVE_SECTIONS` and their screens under `app/settings/`; nothing else changes.
- Developer depends on the sitemap condition `org-allows-personal-tokens`. The navigation generator now resolves the conditions the device decides with the condition met and emits them on the node (`conditions`), and Compass shows Developer when an org the person belongs to allows personal tokens (`listOrgsAllowingPersonalTokens`, as Gateway reads it).
- The list groups the sections as You, Preferences and Work. Device settings (theme, haptics, battery, data, biometric lock, kiosk) stay first, unchanged.

### 2. What queues offline, and what needs a connection

- The person's own rows are kept on the device in device-local tables (`_me_profile`, `_me_person`, `_me_person_skills`, `_me_person_languages`, `_me_person_links`, `_me_person_certifications`, `_me_profile_section_visibility`, `_me_default_org`). A name starting with `_` is never purged by a scope change and is wiped at sign-out with the rest of the encrypted store. Each is read online with the person's session and shown from the device after that, so these sections open offline once opened online.
- A change queues as an ordinary insert or update of the server table, which owner-only row level security admits (0205, 0860, 1340), and lays its optimistic row on the device copy in the same transaction (`src/settings/writes.ts`). A profile or name update sends only the columns that changed and merges with edits made elsewhere (policy `merge`, guarded on `updated_at`). A list insert carries its own id, so a retry is the same row; a removal is the owner's soft delete. A refusal (a handle taken, a verified certification) lands in the offline queue and on the screen with its rule's own sentence.
- What needs the server's answer at once never queues, and its control is disabled offline with a notice: leaving an org or a company account, revoking a profile share, unblocking, account deletion, and everything in Security.
- Alternative: sync the profile tables through the download scope. Rejected: they are the person's own rows across orgs, not an org's, and the scope machinery is per org.

### 3. Security in Compass follows Gateway, step-up included

- Second factors (an authenticator app, set up from the phone with the otpauth link `startTotpEnrollment` now returns), passkeys (renamed and removed here, added in Gateway because a passkey belongs to a web address), recovery codes (shown once, saved with the share sheet) and signed-in sessions use the same `@xos/data` functions as Gateway.
- Step-up is Gateway's rule (`stepUpGate`): a second factor passed in the last 15 minutes before removing a factor or making recovery codes, and, once the person holds a factor, before adding another, removing a passkey or changing the password. The sheet takes a code from the authenticator app or a recovery code; a person whose only factor is a security key confirms in Gateway.
- Compass adds a password form, which Atlas and Gateway do not have: Supabase Auth's `updateUser`, with the code it emails when the session signed in more than a day ago (`secure_password_change`), and the sign-up rules (12 to 256 characters, letters and digits, no name, email or product words). A104's trigger tells the person (`account.security_changed`).
- Compass records its own session (`app.touch_my_session`, surface Compass, user agent `Compass/<version> (iOS <version>)`), so Sessions and devices reads "Compass on iOS". It cannot see its public address and records none.
- Sign in with Apple is Compass's own sign-in method and is not managed here (orch-compass-trust).

### 4. The default org is the sign-in's chosen org

- Section 4.5.6 item 5 asks for a default org, and the settings registry has no such key. Compass's Make Default calls `app.set_active_org` (0920), the selection the access token's `org_id` claim, the public API and account notices already follow, and opens the org on this device. It is idempotent, so it queues as a plain RPC.
- A device that never chose an org opens on the default (`CompassProvider`, `readDefaultOrg`); a device that did keeps its own choice (Section 4.5.7). An org the person only works with can be opened, but `set_active_org` takes memberships only, so it cannot be the default.
- Alternative: a new `me.default_org` personal setting. Rejected for this package, which adds no migration, and because Atlas's context switcher already writes the same selection.

## Consequences

- S4.5.6-44 has the identity group native in Compass; Preferences, Accessibility, Notifications, Out of Office, Work Details, Payout and Tax, Calendar Feeds, Connected Apps and Developer still open Gateway until A111 and A112.
- orch-compass-trust adds `app/settings/profile-privacy.tsx` as a Blocked People screen. A110's Profile Privacy carries the same list with the same test ids (`blocked-unblock`, `blocked-message`), so on merge its screen replaces that file and its Maestro flow keeps passing.
- Spec items Gateway does not offer either stay out of Compass for now: a profile photo, phone and data export under Account, and unlinking a sign-in provider.
- The Compass help article on Profile (`help/articles/*/profile.md`) still says the rest of the profile is edited in Gateway; it now lives under Settings, Profile.
