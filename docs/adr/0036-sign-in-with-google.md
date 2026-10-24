# ADR 0036: Sign in with Google

- Status: Accepted
- Date: 2026-10-20
- Decider: the owner asked for Google as a sign-in method on 2026-10-20; A72 (RRR-117) built it and took the decisions below

## Context

Section 9 lists Google, Apple and Microsoft OAuth among the sign-in methods, and Section 11.10 rule 12 puts passwordless methods first. Atlas and Gateway already had a provider button that appears when Supabase Auth reports a provider enabled, a server action that called `signInWithOAuth`, and an `/auth/callback` route. No provider was configured, the callback mapped every failure to "link expired", and Compass had only the email link and a password.

The owner's remaining work should be creating the Google OAuth clients and entering them in Supabase, Vercel and EAS. Everything else ships here.

## Decision

1. **One account, three sign-in paths.** Google is a sign-in method of the same Supabase Auth account that Atlas, Gateway and Compass share (Section 4.4.1). There is no separate Google sign-up: the first Google sign-in creates the account.

2. **Atlas and Gateway use the web flow with PKCE.**
   - The provider button posts to the `signInWithProvider` server action. It refuses a provider that Supabase Auth does not report as enabled, then calls `signInWithOAuth({ provider: "google" })` on the server client from `@supabase/ssr`. That client uses PKCE: the code verifier is kept in an httpOnly, SameSite=Lax cookie, and only its SHA-256 goes to `/auth/v1/authorize`.
   - Google is asked for its account chooser (`prompt=select_account`), so a person with several Google accounts picks the one an invitation was sent to.
   - The return address is `<site>/auth/callback?next=<path>&provider=google`. `next` is the existing allow-list: `safeNext` keeps only same-site relative paths, so there is no open redirect. Invitation tokens (`/auth/invite/<token>`), the Gateway claim step and org pages travel in `next` and survive the round trip, including a failed one.
   - Supabase Auth accepts that address only when it matches the redirect allow-list as a whole, query string included (checked on a local Supabase Auth v2.197.0). The hosted entries are therefore `https://<origin>/auth/callback**`; an exact `.../auth/callback` entry sends a Gateway sign-in to the Site URL instead (`promote-to-production.md`, step 5, now says so). The second check, on our side, is `safeNext`.
   - `/auth/callback` exchanges the code (with `sb_flow_id` when auth-js adds it) and sets the session cookies. Its redirects use a relative Location: Next names a loopback host `localhost` in `request.url`, and an absolute redirect moved a person signed in on 127.0.0.1 to localhost without their new cookie.
   - Atlas's root page forwards a code or an error that fell back to Supabase Auth's Site URL to `/auth/callback`.
   - The CSP's `form-action` allows `https://accounts.google.com`. Without JavaScript the form posts natively, and browsers check `form-action` on every redirect of that navigation. Apple and Microsoft need their own origin there when they are turned on.
   - Gateway offers providers on its platform hosts only. Supabase Auth returns to `GATEWAY_SITE_URL`, so a sign-in started on an org's custom domain would come back to another host without its verifier cookie.

3. **The Google button follows Google's branding guidelines and the design system.** The label is the catalog string "Continue with Google" ("Continuar con Google"), which is also the accessible name. Google's "G" keeps its four colors on every theme, so it is an image file (an SVG on the web, PNGs at 1x, 2x and 3x in Compass) and never recolored; no color literal enters the code. The button itself is the design system's secondary button (tokens only). The web button is a server-rendered form: it adds no client JavaScript to the sign-in page.

4. **Error states.** Supabase Auth returns to `/auth/callback` with `error`, `error_code` and `error_description` (shapes checked against the local GoTrue). The callback maps them, keeps `next`, and the sign-in page shows the message:

   | Return                                                       | Key                  | Shown as    |
   | ------------------------------------------------------------ | -------------------- | ----------- |
   | `access_denied` with no code (the person closed Google)      | `oauth_cancelled`    | Information |
   | Any other provider error                                     | `provider_error`     | Error       |
   | `provider_email_needs_verification`                          | `email_not_verified` | Error       |
   | `sso_required` or `sso_session_required`                     | `sso_required`       | Error       |
   | `bad_oauth_state`, or a code with no verifier in the browser | `oauth_expired`      | Error       |

   The description is free text and never shown. Compass maps the same cases from the SDK and from `signInWithIdToken`, plus missing Google Play services.

5. **Account linking: Supabase Auth's automatic linking of verified emails.** Manual linking stays off (`enable_manual_linking = false`).
   - When Google returns a verified email that matches an existing account, Supabase Auth adds a google identity to that account. The person keeps their account, organizations, roles and name; Google's claims are merged into the auth metadata only, and `app.people.full_name` is not changed.
   - If the matching account never confirmed its email, Supabase Auth removes its password and other unconfirmed identities before linking (pre-account takeover protection) and confirms the address Google verified.
   - An account created by enterprise single sign-on (`is_sso_user`) is never linked: a Google sign-in with that email is a separate account.
   - `supabase/tests/1310_google_sign_in.test.sql` writes the rows Supabase Auth writes for a Google sign-up and for a link, and checks the outcome described here.

6. **The bootstrap is the email sign-up's.** A first Google sign-in inserts into `auth.users`, so `private.handle_new_auth_user` creates the person, taking `full_name` from Google's claims. Without `next`, `/` sends a person with no organization to `/auth/organization`, where the Owner creates the org and accepts the Terms of Service and the DPA. Invitations, verified-domain joins and the custom access token hook (the active `org_id` claim) work the same, since none of them looks at the sign-in method. No migration was needed.
   - **Gateway's Worker Terms.** A person creating a Gateway account accepts the Worker Terms before the account exists (finding A59-025): the sign-up form keeps the acceptance in the new user's metadata and the first session writes it to `app.legal_acceptances`. Google creates the account before any form, so `/auth/callback` sends an account that comes back from a provider without an accepted Worker Terms (and none waiting in its metadata) to `/auth/terms`, which shows the same box, writes the acceptance through `app.record_legal_acceptances` and continues to `next`. An existing account without an acceptance is asked the same way the first time it uses Google on Gateway.

7. **Org sign-in policy: there is none to enforce today.** Orgs can register a SAML or OIDC identity provider for just-in-time joins and SCIM (`app.identity_providers`, migration 0638), but no setting lets an org require single sign-on or restrict sign-in methods, and no app offers SSO sign-in yet. Google sign-in is therefore allowed for every org. The `sso_required` message exists so that an enforcement, when it is built, reports through the same path; `sso_session_required` from `app.join_by_sso` maps to it.

8. **Compass signs in natively.**
   - `@react-native-google-signin/google-signin` 16.1.5 (MIT), Supabase's documented path for Expo, gets a Google ID token; `supabase.auth.signInWithIdToken({ provider: "google", token })` exchanges it for the session. expo-auth-session was not chosen: it runs the OAuth flow in the system browser and returns through a redirect URI, while the SDK uses Google's native account picker and Google Play services.
   - `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` (the ID token's audience on both platforms) and `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` are public build values. The button shows on Android with the first and on iOS with both. `app.config.ts` adds the SDK's config plugin with the iOS URL scheme only when the iOS client ID is set.
   - Signing out of Compass also signs out of Google on the device, so the next sign-in shows the account picker.

9. **The nonce check is skipped for ID tokens (`skip_nonce_check = true`).** Google's iOS SDK puts its own nonce in the ID token and does not reveal it, and the free SDK version cannot pass one in, so Compass cannot send Supabase Auth a matching nonce. Supabase documents "Skip nonce checks" for this case. The web flow is not affected: Supabase Auth exchanges the code with Google itself. The remaining checks still apply: Google's signature, the issuer, expiry, and an audience among the configured client IDs. A captured ID token could be replayed within its hour of validity; turning the check back on needs an SDK that accepts a nonce (Universal Sign In, the paid version of the same library).

10. **Configuration.**
    - `supabase/config.toml` enables `[auth.external.google]` with `client_id = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID)"` and `secret = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)"`, the local stack's callback as `redirect_uri`, and the nonce setting above. `infra/security/test/auth-config.test.ts` keeps both values coming from the environment.
    - With both variables unset the local stack still starts: the CLI 2.120 passes the `env()` text through as the client ID, the button shows (the journeys rely on it) and Google refuses the sign-in. Exporting both variables and restarting the stack makes local Google sign-in work.
    - The hosted project is configured in the dashboard; the owner's steps are in `infra/runbooks/production.md`, "Sign in with Google (OWNER)".

## Consequences

- People can sign in to Atlas, Gateway and Compass with Google once the owner creates the clients. Until then nothing changes in production: the provider is off in the hosted project, so no button appears.
- Every local stack and CI shows the Google button on sign-in and sign-up. Gate 6 journeys (`google-sign-in.spec.ts` in Atlas and Gateway) check the authorize request, the error states, Gateway's Worker Terms step and axe. They stop the browser at `/auth/v1/authorize` with `page.route`. `page.route` does not see the hops of a redirect, so the no-JavaScript journey sends the form's POST itself and never lets the browser follow the redirect.
- Unit tests run the real `@supabase/ssr` client against an in-memory cookie jar: the challenge is the SHA-256 of the stored verifier, and the callback exchanges with it and sets the session cookie.
- The privacy policy draft names "You" as the source of account data; Google becomes a source when a person signs in with it. That text is the owner's and the legal track's to update.

## Follow-ups

- The Worker Terms step is a page, not a gate: a person who leaves it stays signed in without an acceptance and is asked again at their next Google sign-in on Gateway. Holding every Gateway page until the acceptance exists would close that.
- Compass creates accounts without the Worker Terms, by email link as before and now by Google; Compass has no acceptance step yet.

- Magic links started on an org's custom Gateway domain have the same return-host problem as OAuth (decision 2) and are not changed here.
- Apple and Microsoft: the same buttons, callback and messages apply; each needs its brand mark, its CSP origin and its own owner setup.
- Single sign-on enforcement per org, if an org asks for it, would raise `sso_required` (decision 7).

## Amendment (2026-10-23): Sign in with Apple in Compass

ADR 0033 decision 58 (2026-10-23) adds Sign in with Apple to Compass before App Store submission, and keeps the Google button off iOS until then: App Store Review Guideline 4.8 asks an app that offers a third-party sign-in to offer an equivalent private one, and Sign in with Apple is it. Track compass-trust (RRR-137) built it.

1. **Compass signs in natively on iOS.** `expo-apple-authentication` 57.0.2 (MIT, Expo's module for SDK 57) shows Apple's sheet, asking for the name and email, and returns an identity token; `supabase.auth.signInWithIdToken({ provider: "apple", token, nonce })` exchanges it for a session, as Google's token is exchanged (decision 8). It is the same account: a verified email links to the existing person (decision 5), and the bootstrap is the email sign-up's (decision 6).

2. **The nonce is checked.** Unlike Google's iOS SDK (decision 9), Apple's takes a nonce. Compass makes 32 random bytes with `expo-crypto`, gives Apple their SHA-256 as hex, which Apple signs into the token, and gives Supabase Auth the bytes themselves, which Supabase Auth hashes and compares. The hosted Apple provider keeps "Skip nonce checks" off. A new nonce is made for every sign-in and is never stored.

3. **Which buttons show is explicit configuration.** `EXPO_PUBLIC_APPLE_SIGN_IN=1`, a public EAS build value, turns Apple on: `app.config.ts` then sets `ios.usesAppleSignIn` and adds the module's config plugin (the `com.apple.developer.applesignin` entitlement). On iOS, Apple shows when the build turned it on and `isAvailableAsync` answers true, and Google shows only beside Apple; an iOS build without Apple configured shows neither. Android and other platforms keep Google as decision 8 describes, and never show Apple. `apps/compass/src/domain/appleSignIn.ts` holds the rule (`signInButtons`) and the flow (`signInWithApple`); `test/apple-sign-in.test.ts` covers both with fakes.

4. **The button is Apple's own.** `AppleAuthenticationButton` (Sign In type, black on a light theme and white on a dark one, the design system's control radius) follows Apple's Human Interface Guidelines; iOS draws its label and reads it aloud in the device's language, so it takes no catalog string. The error messages are catalog strings (`compass.signIn.appleCancelled`, `appleFailed`, `appleUnavailable`), and Supabase Auth's refusals map as Google's do (decision 4).

5. **The name.** Apple sends the person's name on the first authorization only and never in the token. Compass keeps it in the auth metadata and on the person row while that row has no name, so a sign-in that links an existing account never renames it (decision 5). Keeping it is best effort: a failure is logged and the sign-in still succeeds.

6. **Atlas and Gateway do not offer Apple.** Turning the provider on for Compass would otherwise put a "Continue with Apple" button on their sign-in pages. Their web flow needs Apple's own button style, Apple's origin in the CSP's `form-action` and a client secret that Apple accepts for at most six months, none of which they have, so `parseEnabledProviders` leaves Apple out on both until that flow is built.

7. **Configuration.** `supabase/config.toml` keeps `[auth.external.apple]` off: a native Apple sign-in needs a device build signed by the Apple team, which a local stack never sees. The owner's steps (the capability on the App ID, the Services ID, the key and the `apple-revoke` secrets, the Supabase provider with Compass's bundle ID first among the client IDs, the private relay email domain, and the EAS value) are in `infra/runbooks/production.md`, "Sign in with Apple (OWNER)", and `legal/OWNER_INPUTS.md`, Part E.

8. **Deleting the account revokes Compass's Apple tokens.** Apple expects an app that offers Sign in with Apple to revoke the person's tokens when they delete their account (App Store Review Guideline 5.1.1(v)). When the account has an Apple identity, Compass's account deletion (1112) first shows Apple's sheet once more, asking for nothing, and posts the fresh authorization code with the build's bundle ID to the `apple-revoke` Edge Function. With the caller's own token, the function reads the subject of their Apple identity from Supabase Auth, exchanges the code at Apple's token endpoint with a five-minute ES256 client secret the Sign in with Apple key signs (Web Crypto, `packages/platform/src/apple-sign-in/revoke.ts`), checks that the identity token Apple returns names that same subject, and revokes the refresh token. Nothing is stored, so no token outlives the request. Closing Apple's sheet stops the deletion; anything else that keeps Compass from revoking (no Apple sheet on the device, the function not set up, Apple or the network failing) lets the deletion go ahead, and the confirmation tells the person to remove Compass from Sign in with Apple in their Apple Account settings. A deletion from Gateway, and one in a tenant build signed by the tenant's own team, gets no revocation; the person can remove Compass the same way. `packages/platform/test/apple-revoke.test.ts` and `apps/compass/test/apple-sign-in.test.ts` cover both sides with a runtime key and fakes.

### Follow-ups

- The web flow in Atlas and Gateway, as decision 6 of this amendment describes.
- The Privacy Policy names Apple, as it should Google, as a source of account data (the legal track).
