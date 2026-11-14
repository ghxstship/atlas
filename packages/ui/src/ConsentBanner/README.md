# ConsentBanner

ConsentBanner asks a visitor once which cookies a site may set, and ConsentSettings is the page where the choice is changed. Atlas and the marketing site render the same two components.

- Import them from `@xos/ui/consent`, or from `@xos/ui` on the client. Both components are client modules; the adapter contract in `consent.ts` has no React and runs anywhere.
- Accept and Reject are the same Button at the same size, side by side. Neither is primary, and neither has focus when the banner opens. No category behind Choose starts ticked.
- Global Privacy Control is a refusal. Pass `gpc` when the request carries `Sec-GPC: 1` (`sendsGlobalPrivacyControl`); the components also read `navigator.globalPrivacyControl`. Under the signal the banner shows the confirmation in place of the choices, and the settings page says so and locks the optional categories and Accept.
- Every string is a prop. The one exception is the confirmation, which falls back to the `mk.consent.gpc` message of the `ui` catalog when `gpcLabel` or `gpcNotice` is not passed.
- A category `name` is a letter followed by letters, digits, underscores or hyphens, 64 characters at most (`CONSENT_CATEGORY_NAME`): `preferences`, `analytics_storage` and `Marketing` fit. The cookie adapter rejects a write with any other name, and reads nothing from a cookie that holds one.
- The links are plain anchors. An app with a router passes `renderLink` to draw them with its own link component.

## From a server component

A server component can pass only props that serialize: the copy, `gpc`, `policy`, `settings`, `categories`, `cookies`, a string `status`, and `action` as a URL or a server action. That is how Atlas renders both components.

`record`, `onChoice`, `renderLink` and a function `status` are functions or hold functions. They must be passed from a file of the consumer's marked `"use client"`; a server component that passes them fails to render.

## Where the decision is kept

The components never touch storage. They work in one of three ways:

1. `action`: plain forms post the choice to a URL or a function (a Next.js server action). The fields are `choice` (`all`, `none` or `save`) and each ticked category by name with the value `on`. The forms work before any script loads. Atlas uses this.
2. `record`: an adapter and a policy version. The banner reads the adapter once, stays hidden when a decision exists, and writes each decision with its timestamp, the policy version and the Global Privacy Control flag.
3. `onChoice` alone: the consumer hears the choice and does the rest.

### Global Privacy Control that only the browser reports

When `navigator.globalPrivacyControl` is on and `gpc` was not passed, the server has not seen the signal. What happens depends on the mode:

- `record`: the refusal is written through the adapter once, flagged as a signal.
- `action` as a function: it is called once per mount with `choice=none` and `gpc=1`. The receiver should do nothing when it already holds a refusal from the signal, as Atlas's `saveCookieChoice` does.
- `action` as a URL: nothing is sent, because the banner shows no form under the signal and makes no request of its own. Record the refusal from `onChoice("none")`, or pass `gpc` from the request header.
- In every `action` mode, each form still on screen (the two on ConsentSettings) carries a hidden `gpc` field with the value `1`, so a choice made there keeps the flag.

`onChoice("none")` is called once in all of these.

## The adapter

```ts
interface ConsentState {
  readonly categories: Readonly<Record<string, boolean>>;
  readonly gpc: boolean;
}
interface ConsentDecision extends ConsentState {
  readonly decidedAt: string; // ISO 8601, UTC
  readonly policyVersion: string;
}
interface ConsentAdapter {
  read(): Promise<ConsentState | null>;
  write(decision: ConsentDecision): Promise<void>;
}
```

`cookieConsentAdapter()` is the reference implementation with no database: the whole decision lives in one first-party cookie, `xos-consent-decision`, for 12 months. It reads and writes `document.cookie` by default.

- It never throws. Storage that cannot be reached and a category name outside the rule reject; the components then keep the choices on screen.
- It takes any `store` with `get` and `set`, so a server can back it with its response cookies. Encoding is the store's job: `get` returns and `set` receives the decoded JSON value. A framework's cookie jar encodes and decodes by itself, as the default `document.cookie` store does, so a decision the server writes is read in the browser and the other way round.
- On a server with no `store`, `read` resolves null and `write` rejects.

A site with no database keeps the decision in the cookie from a small client file:

```tsx
"use client";

import { ConsentBanner, cookieConsentAdapter, type ConsentBannerProps } from "@xos/ui/consent";
import { useState } from "react";

/** The copy comes in as props from the server page; the adapter is made here, in the browser. */
export function SiteConsentBanner(props: Omit<ConsentBannerProps, "record" | "action">) {
  const [record] = useState(() => ({
    adapter: cookieConsentAdapter(),
    policyVersion: "cookie-policy 1.0.0",
  }));
  return <ConsentBanner {...props} record={record} />;
}
```

```tsx
// A server page or layout: strings only.
<SiteConsentBanner
  title={copy.title}
  body={copy.body}
  policy={{ label: copy.policy, href: "/legal/cookie-policy" }}
  acceptLabel={copy.accept}
  rejectLabel={copy.reject}
  chooseLabel={copy.choose}
  necessary={copy.necessary}
  categories={[{ name: "preferences", label: copy.preferences }]}
  saveLabel={copy.save}
/>
```

Atlas keeps its own adapter, over the consent log in the platform database, in `apps/atlas/lib/privacy/consent-adapter.ts`.
