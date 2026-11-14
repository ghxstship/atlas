# ConsentBanner

ConsentBanner asks a visitor once which cookies a site may set, and ConsentSettings is the page where the choice is changed. Atlas and the marketing site render the same two components.

- Import them from `@xos/ui/consent` on a server component, or from `@xos/ui` on the client. Both files are client modules; the adapter contract in `consent.ts` has no React and runs anywhere.
- Accept and Reject are the same Button at the same size, side by side. Neither is primary, and neither has focus when the banner opens. No category behind Choose starts ticked.
- Global Privacy Control is a refusal. Pass `gpc` when the request carries `Sec-GPC: 1` (`sendsGlobalPrivacyControl`); the components also read `navigator.globalPrivacyControl`. Under the signal the banner shows the confirmation in place of the choices, and the settings page says so and locks the optional categories and Accept.
- Every string is a prop. The one exception is the confirmation, which falls back to the `mk.consent.gpc` message of the `ui` catalog when `gpcLabel` or `gpcNotice` is not passed.

## Where the decision is kept

The components never touch storage. They work in one of three ways:

1. `action`: plain forms post the choice to a URL or a function (a Next.js server action). The fields are `choice` (`all`, `none` or `save`), each ticked category by name with the value `on`, and `gpc` with the value `1` when only the browser reported the signal. The forms work before any script loads. Atlas uses this.
2. `record`: an adapter and a policy version. The banner reads the adapter once, stays hidden when a decision exists, and writes each decision with its timestamp, the policy version and the Global Privacy Control flag.
3. `onChoice` alone: the consumer hears the choice and does the rest.

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

`cookieConsentAdapter()` is the reference implementation with no database: the whole decision lives in one first-party cookie, `xos-consent-decision`, for 12 months. It reads and writes `document.cookie` by default and takes any store with `get` and `set`, so a server can back it with its response cookies.

```tsx
<ConsentBanner
  title={copy.title}
  body={copy.body}
  policy={{ label: copy.policy, href: "/legal/cookie-policy" }}
  acceptLabel={copy.accept}
  rejectLabel={copy.reject}
  chooseLabel={copy.choose}
  necessary={copy.necessary}
  categories={[{ name: "preferences", label: copy.preferences }]}
  saveLabel={copy.save}
  record={{ adapter: cookieConsentAdapter(), policyVersion: "cookie-policy 1.0.0" }}
/>
```

Atlas keeps its own adapter, over the consent log in the platform database, in `apps/atlas/lib/privacy/consent-adapter.ts`.
