# Sign-up and sign-in links

The addresses other sites link to when they send a person to Atlas, and the parameters those addresses read. The marketing site (`ghxstship/atlas-marketing`) cites this file; `design/MARKETING_LOCKSTEP.md` names it as a product fact, so a change here is a lockstep change.

## Addresses

| Purpose           | Address                                     |
| ----------------- | ------------------------------------------- |
| Create an account | `https://atlas.ghxstship.tech/auth/sign-up` |
| Sign in           | `https://atlas.ghxstship.tech/auth/sign-in` |

## The `plan` parameter

`/auth/sign-up?plan=<code>` and `/auth/sign-in?plan=<code>` carry the plan a buyer chose on a pricing table.

- **Accepted values.** A plan `code` from `packages/schemas/plans.yaml` that is sold by self-serve Checkout: a plan with a `stripe` block. At this release those are `core`, `pro` and `team`. The value is matched exactly, in lower case as the file writes it.
- **Everything else is dropped.** `access` (the free plan), `enterprise` (sold by quote), an unknown code, a different case, an empty value and a repeated parameter are ignored without a message. The person signs up or signs in exactly as they would with no parameter.
- **What the person sees.** The sign-up page and the organization step say which plan was selected and that creating an account charges nothing. Once the organization exists, its new Owner lands on Billing and Plan (`/<org>/settings/billing-and-plan?plan=<code>`), where a notice names the plan and that plan's card is marked; the Monthly and Annual links on that page keep the plan. The link from sign-in to sign-up, and back, keeps it as well. A person who signs in and already owns an organization lands on the same page of that organization.
- **What it never does.** It starts no Checkout, makes no charge, changes no plan and leaves the trial exactly as it is. The organization is created on the same plan and trial as any other. Paying for a plan still takes the Owner's own steps on Billing and Plan: choosing the plan, reading its renewal terms and agreeing to them (ADR 0161).
- **Who sees it.** Only an Owner. Billing and Plan answers 404 to every other role, and a person who owns no organization goes to their usual start page.
- **With `next`.** `next` wins. An invitation link sets `next`, and an invited person creates no organization, so `plan` is ignored there.

Example: the Pro button on a pricing table links to `https://atlas.ghxstship.tech/auth/sign-up?plan=pro`.

## How it is carried

The checked code rides inside `next`, the same-site address a person continues to after signing in, as `/?plan=<code>`. `next` already travels through the password form, the emailed link, Google sign-in, single sign-on, the second factor and the age question, and it is part of the address in a confirmation email, so the plan survives a confirmation opened in another browser or on another device. Nothing is stored: no cookie, no database row and no account metadata. Every page that reads the parameter checks it again against the plan list (`apps/atlas/lib/auth/plan-intent.ts`), and only the plan list's own code is ever written into a page or an address.

## The `next` parameter

`next` is a same-site path to continue to after signing in. Anything that could leave the site is replaced with the default (`apps/atlas/lib/auth/redirect.ts`). Other sites do not need to set it.
