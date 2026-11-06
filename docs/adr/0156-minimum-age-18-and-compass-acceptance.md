# ADR 0156: One Minimum Age of 18, Compass First Sign-In Acceptance and the AI Choice

- Status: Proposed
- Date: 2026-11-06
- Decider: AI, under the owner's instruction to choose the most future-proof, legally defensible option. No attorney has reviewed these calls.
- Addresses: legal issue 4 (RRR-248)
- Migrations: 6155 (range 6155 to 6159)
- Amends: ADR 0033 decision 54 (the minimum age of 16)

## Context

Compass recorded no acceptance and asked no age, so the Mobile EULA's liability cap, venue and Apple clauses rested on use of the app alone. The documents said a minimum age of 16, the Google Play target audience said 18 and over, the rating work expected below 16, and the AI text said 18 or older with nothing enforcing it. Compass sent receipt photos to the AI provider on capture, on an Admin's setting alone, while Apple guideline 5.1.2(i) asks for the person's explicit permission before personal data goes to a third-party AI.

## Decision

1. **One minimum age of 18 for every XOS account, in every app.** XOS is a workplace tool, and 18 is the age that fits the AI provider's terms, Google Play and children's privacy law alike. Minors at an event are records the responsible adult or organization keeps, with no account of their own.
2. **A neutral question, on the web and on the phone.** The FTC warns against a box that only invites "I am old enough". Both answers show with equal weight and the rule is stated only after someone answers under 18. A full birth date was rejected: it would collect a date we have no use for, and asking 18 or older answers the only question XOS has.
3. **Compass asks before anything else.** After the second factor and before identity, downloads or push, a sign-in answers the age and accepts the Mobile EULA, plus the Worker Terms when the person holds an engagement or a roster entry, or no active membership. Answers go to the same logs web sign-up uses (`private.age_confirmations`, `app.legal_acceptances`), with version, time and person. Google, Apple and email sign-ins all pass here, since the step follows the session.
4. **The step needs the server, and Compass says why.** A person who has never passed it is told to connect. A person the server cleared before, or an install that already holds a cached identity, keeps working offline and is asked once the server answers: stopping a worker's time clock on a site with no signal does real harm, and the question comes at the first chance.
5. **A material change prompts through the existing mechanism** (`app.pending_legal_reacceptances`, migration 1383). During its 30 days of notice it is a dismissible prompt; from its effective date it holds Compass until accepted, since the license is the condition of using the app. Atlas and Gateway keep their banners.
6. **Under 18 means no account.** Before an account exists, nothing is created or kept. An account with no org behind it is removed entirely. An account with org records is deleted as `app.delete_my_account` does, so orgs keep what the law requires and learn only of an erasure. A legal hold, an open shift or being the only owner stops deletion, and the person is told to contact us. Each case adds one row to `private.age_refusals`: surface, time and outcome, and nothing that identifies anyone.
7. **A confirmation at 16 stays as evidence and no longer counts.** Web sign-in asks those people again; Compass asks at its next launch.
8. **The AI choice is the person's, and a decline binds on the server.** The first time an AI feature would send anything in Compass, it names the provider category and the provider, says what goes to it, and records the choice with the version of the words shown. `app.ai_begin_request` refuses a person who declined and `app.ai_enabled_features` answers nothing, whichever app asks, so saying no in Compass is honored everywhere. Nothing is sent without Allowed in Compass, and the choice can be changed in Settings. Atlas does not ask yet: a person with no recorded choice keeps the org's setting there.

## Alternatives rejected

- **Guardian assent for 16 and 17 year olds.** It adds a consent flow, a second identity to verify and a disaffirmance risk, for a workplace tool that has no need of it.
- **Keeping a hash of the refused email to stop a second attempt.** It would keep an identifier for the person the rule exists to protect. The FTC's suggestion against changing an answer is a device-level one, which matters most for a child-directed audience, and XOS has none.
- **Blocking offline use for anyone who has not answered.** See decision 4.
- **Recording the AI choice only on the device.** A choice that cannot be shown later and does not bind the server is not worth much.

## Consequences

- The Terms, Privacy Policy, Mobile EULA, Worker Terms, AUP and AI Features Notice must say 18 and describe these steps.
- Store answers change: see `apps/compass/store/age-rating.md`.
- `app.opportunities.minimum_age` still allows 16 and 17, and the frozen API documents a minimum of 16. A posting cannot reach anyone under 18 now that every account is 18 or older, so it is left alone until a later API version.
- Web accounts with no age answer at all keep working until they create or join an org, where the question already stands; only a confirmation at 16 triggers the question at sign-in.
- Demo seeds answer for the demo people, so journeys that sign in as them start on their own screens.
