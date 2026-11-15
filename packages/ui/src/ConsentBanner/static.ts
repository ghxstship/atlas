/**
 * The cookie banner for a server component: no hooks, context or event handlers, so rendering it
 * sends no JavaScript (ADR 0027). `@xos/ui/consent` has the client components and the adapter.
 */
export {
  ConsentBannerStatic,
  type ConsentBannerStaticProps,
  type ConsentStaticLinkRenderer,
} from "./ConsentBannerStatic.tsx";
export type { ConsentCategory, ConsentLink } from "./ConsentBanner.tsx";
export { sendsGlobalPrivacyControl } from "./consent.ts";
