/**
 * The Marketing layer for public pages (design handoff section 10, decision D20). A server
 * component imports from here: the components that hold no state use no hooks and no context, so
 * they render on the server and send no JavaScript, and the five that hold state (MarketingNav,
 * PersonaSwitcher, PricingTable, CodeSample and MarketingFooter) are client modules of their own
 * (ADR 0027). The server-rendered ones that print a shared string or format a number take the
 * page's `locale` and `messages`; the five client ones read the nearest XOSProvider.
 *
 * Styles: import "@xos/ui/marketing.css" after "@xos/ui/styles.css".
 */
export type * from "./Marketing/Marketing.types.ts";
export { marketingCopy, type MarketingCopy } from "./Marketing/marketing-copy.ts";
export { ButtonLink } from "./Marketing/ButtonLink.tsx";
export { MarketingSection } from "./Marketing/MarketingSection.tsx";
export { MarketingHero } from "./Marketing/MarketingHero.tsx";
export { ScreenshotFrame } from "./Marketing/ScreenshotFrame.tsx";
export { ProofStatStrip } from "./Marketing/ProofStatStrip.tsx";
export { GateLifecycleRail } from "./Marketing/GateLifecycleRail.tsx";
export { SurfaceTriptych } from "./Marketing/SurfaceTriptych.tsx";
export { FeatureGrid } from "./Marketing/FeatureGrid.tsx";
export { ComparisonTable } from "./Marketing/ComparisonTable.tsx";
export { PriceDisplay } from "./Marketing/PriceDisplay.tsx";
export { FAQ } from "./Marketing/FAQ.tsx";
export { Testimonial } from "./Marketing/Testimonial.tsx";
export { LogoSlotWall } from "./Marketing/LogoSlotWall.tsx";
export { AIDisclosureBadge } from "./Marketing/AIDisclosureBadge.tsx";
export { MarketingNav } from "./Marketing/MarketingNav.tsx";
export { PersonaSwitcher } from "./Marketing/PersonaSwitcher.tsx";
export { PricingTable } from "./Marketing/PricingTable.tsx";
export { CodeSample } from "./Marketing/CodeSample.tsx";
export { MarketingFooter } from "./Marketing/MarketingFooter.tsx";
