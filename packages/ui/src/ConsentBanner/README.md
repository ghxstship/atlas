# ConsentBanner

ConsentBanner asks a visitor once which cookies a site may set, and ConsentSettings is the page where the choice is changed. The marketing site renders both. Atlas renders ConsentSettings and, on every route, the script-free ConsentBannerStatic described below.

- Import them from `@xos/ui/consent`, or from `@xos/ui` on the client. Both components are client modules; the adapter contract in `consent.ts` has no React and runs anywhere.
- Accept and Reject are the same Button at the same size, side by side. Neither is primary, and neither has focus when the banner opens. No category behind Choose starts ticked.
- Global Privacy Control is a refusal. Pass `gpc` when the request carries `Sec-GPC: 1` (`sendsGlobalPrivacyControl`); the components also read `navigator.globalPrivacyControl`. Under the signal the banner shows the confirmation in place of the choices, and the settings page says so and locks the optional categories and Accept.
- Every string is a prop. The one exception is the confirmation, which falls back to the `mk.consent.gpc` message of the `ui` catalog when `gpcLabel` or `gpcNotice` is not passed.
- A category `name` is a letter followed by letters, digits, underscores or hyphens, 64 characters at most (`CONSENT_CATEGORY_NAME`): `preferences`, `analytics_storage` and `Marketing` fit. The cookie adapter rejects a write with any other name, and reads nothing from a cookie that holds one.
- The links are plain anchors. An app with a router passes `renderLink` to draw them with its own link component.

## A bar at the bottom of the viewport

Both banners draw the same bar (`bar.ts`, decision 2026-11-27): full width at the bottom edge of the viewport, with a border and the menu shadow on top, safe-area padding for a phone's home indicator and corners, and at most 60% of the viewport tall, scrolling inside when Choose is open on a short screen. Print hides it.

- Render it as a direct child of the body, or of the element that holds the whole page, ahead of the page content. It stays first in the DOM, so keyboard and screen reader users reach it before the page.
- It reserves its own space with no script. `[data-xos-consent-bar]` makes its parent a flex column at least the viewport tall (`styles/base.css`), and the bar takes `order-last`, an auto top margin and `position: sticky; bottom: 0`. While the page scrolls it stays at the bottom edge like a fixed bar; at the end of the page it sits in the flow after the footer, so the last button and the footer are never under it, with Choose closed or open. A spacer or a body padding would need the bar's height, which changes with the copy, the language and the screen width.
- A browser without `:has()` draws the bar in place, at the top of the page.
- On the z-index scale it is `z-header`: over the page, sticky rows and the sidebar, under dropdowns, popovers, side peeks, dialogs, the command menu, toasts and tooltips. Those overlays are drawn over the bar when they open; none is drawn under it.
- An app shell one viewport tall that scrolls inside itself (Atlas's `h-dvh` shell, whose bottom tab bar is sticky inside it) marks its root `data-xos-viewport` and renders as a sibling of the bar. The parent is then exactly the viewport tall and the shell takes the height the bar leaves, so the tab bar and the end of the shell's scroll area sit just above the bar and nothing is under it. Beside a shell the bar is at most the viewport less the shell's minimum height (`--ui-shell-min`, and never under 30% of the viewport), and scrolls inside past that. On a screen shorter than the shell's minimum plus 30% (a phone held sideways) the shell runs past the viewport and the page scrolls to its end, as it did with no bar.
- While the bar is on the page the root's `scroll-padding-bottom` is its cap (`--ui-consent-bar-max`, the same token as its max height) plus a gap, so keyboard focus, `scrollIntoView` and fragment links stop above it and no focused control is hidden under it (WCAG 2.4.11). The cap, not the bar's height, because no script measures the bar; the page can always scroll that far, since at its end the bar sits in the flow. On a phone with the bottom tab bar the two paddings add up (A23-001).
- Scroll padding cannot move an element pinned to the viewport. A sticky or fixed element that scrolls inside itself, such as the legal outline, carries `data-xos-pinned`: while the bar is on the page it ends above the bar's cap (and the phone tab bar) and scrolls inside past that, with its own scroll padding, so its lower links are never under the bar for the keyboard or the mouse.
- Fixed controls drawn at the bottom edge on the toast layer are drawn over the bar, as the z-index scale says. Atlas keeps its help tour offer and tips off the page while the bar shows (the shell reads the same consent state on the server), and a tour the person starts sits above the bar's tallest height beside the shell (`--ui-consent-bar-shell-max`).

## With no script

`ConsentBannerStatic`, from `@xos/ui/consent/static`, is the same banner with no hooks, context or event handlers: a server component that renders it sends no JavaScript for it. Atlas shows it on every route, because the client ConsentBanner adds about 7 KB of script to each page that renders it.

- It takes the same copy props, a required `action` (a URL or a server action) and an optional `renderLink`, which a server component can pass directly because nothing crosses to the client.
- It reads nothing from the browser. The server decides whether to render it, and passes `gpc` and `gpcLabel` when the request carries `Sec-GPC: 1` to show the confirmation in place of the choices.
- It keeps no record and does not see `navigator.globalPrivacyControl`. Use ConsentBanner with `record` where the banner keeps the decision through an adapter, as a site with no server does.

## From a server component

A server component can pass only props that serialize: the copy, `gpc`, `policy`, `settings`, `categories`, `cookies`, a string `status`, and `action` as a URL or a server action. That is how Atlas renders ConsentSettings. The rule covers the two client components; ConsentBannerStatic is rendered on the server, so it takes any prop.

`record`, `onChoice`, `renderLink` and a function `status` are functions or hold functions. They must be passed from a file of the consumer's marked `"use client"`; a server component that passes them fails to render.

## Where the decision is kept

The components never touch storage. They work in one of three ways:

1. `action`: plain forms post the choice to a URL or a function (a Next.js server action). The fields are `choice` (`all`, `none` or `save`) and each ticked category by name with the value `on`. The forms work before any script loads. Atlas uses this for ConsentSettings.
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
