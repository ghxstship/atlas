# Public pages: the Marketing layer on its own

A public page that renders only the Marketing layer of `@xos/ui` ships two things smaller than a product shell does: the stylesheet and the shared strings. This file is the supported way to do both (lockstep issue 123). Atlas, Gateway and Console do not use it; their entries, `@xos/ui/styles.css` and `@xos/ui/marketing.css`, are unchanged.

## Styles: `@xos/ui/marketing/styles.css`

`@xos/ui/styles.css` has Tailwind scan every component in the package, so a page compiles utilities for product components it never renders. `@xos/ui/marketing/styles.css` is a second Tailwind 4 entry that scans only `src/Marketing` and the modules those components import.

In the page's global stylesheet, replace

```css
@import "@xos/ui/styles.css";
@import "@xos/ui/marketing.css";
```

with

```css
@import "@xos/ui/marketing/styles.css";
```

The entry loads the same token variables for Dark, Light and Sunlight, the same base rules and component rules, and the Marketing sheet, so no other import is needed. Tailwind still scans the page's own sources as before.

Compiled for a page with one element, minified by Tailwind 4.3.3 at release 4.19.0:

| Entry                                            | Bytes   | Gzip   |
| ------------------------------------------------ | ------- | ------ |
| `@xos/ui/styles.css` and `@xos/ui/marketing.css` | 111,932 | 19,774 |
| `@xos/ui/marketing/styles.css`                   | 69,975  | 12,851 |

### Other `@xos/ui` components on the page

The entry covers what a page imports from `@xos/ui/marketing`. A page that also renders a component from another entry of the package, such as the consent banner from `@xos/ui/consent`, names that component's folder after the import, with the path from the stylesheet to the installed package:

```css
@import "@xos/ui/marketing/styles.css";
@source "../node_modules/@xos/ui/src/ConsentBanner";
```

Without that line the component renders without its utilities. A folder holds a component and the files beside it; a component that imports from another folder needs that folder named too.

## Strings: the `ui` namespace by message group

Every visible string of the components is in the `ui` namespace of `@xos/i18n`, and `@xos/ui` falls back to the whole en-US file, `@xos/i18n/messages/en-US/ui.json` (16.8 KB), wherever a client component reads a string. `@xos/i18n` also publishes that namespace in parts, for `en-US` and `es-US`:

| Import                                      | Holds                                                                                                                              |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `@xos/i18n/ui/<locale>/<group>.json`        | One message group under its own key, for example `{ "mk": { ... } }`. Spreading several gives a catalog of the shape of `ui.json`. |
| `@xos/i18n/ui-cuts/<locale>/marketing.json` | Every group the Marketing layer reads: `brand`, `link`, `mk`, `nav`, `phase` and `tooltip` (1.6 KB in en-US).                      |

A test in this package fails when a Marketing component reads a group the cut does not hold, so the cut is complete for `@xos/ui/marketing` at every release.

### The en-US fallback in the browser

Alias the whole catalog to the cut for the browser build. The server keeps the whole catalog. In Next.js with Turbopack:

```ts
turbopack: {
  resolveAlias: {
    "@xos/i18n/messages/en-US/ui.json": { browser: "@xos/i18n/ui-cuts/en-US/marketing.json" },
  },
},
```

This is the alias Atlas itself sets in `apps/atlas/next.config.ts`, there to a file of its own. The module specifier on the left is the supported alias point: `@xos/ui` imports the fallback under exactly that name, in `src/lib/i18n.ts`, and nowhere else.

### Another locale

Any other locale's strings reach the components through `XOSProvider` on the client and through the `locale` and `messages` props on the server-rendered components. Pass the cut, not the whole file:

```ts
import { flattenMessages } from "@xos/ui/marketing";
import marketing from "@xos/i18n/ui-cuts/es-US/marketing.json" with { type: "json" };

const messages = flattenMessages(marketing);
```

### Other groups

A page that renders components beyond the Marketing layer adds the groups they read, in the alias target and in the messages it passes:

```ts
import marketing from "@xos/i18n/ui-cuts/en-US/marketing.json" with { type: "json" };
import gate from "@xos/i18n/ui/en-US/gate.json" with { type: "json" };
import result from "@xos/i18n/ui/en-US/result.json" with { type: "json" };

const catalog = { ...marketing, ...gate, ...result };
```

A key the browser's catalog lacks renders as the key and differs from the server's markup, so the list must cover every client component on the page.
