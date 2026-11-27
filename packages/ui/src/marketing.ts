/**
 * The Marketing layer for public pages (design handoff section 10, decision D20). A server
 * component imports from here: the components that hold no state use no hooks and no context, so
 * they render on the server and send no JavaScript, and the five that hold state (MarketingNav,
 * PersonaSwitcher, PricingTable, CodeSample and MarketingFooter) are client modules of their own
 * (ADR 0027). The server-rendered ones that print a shared string or format a number take the
 * page's `locale` and `messages` (`flattenMessages` turns a locale's nested `ui` catalog into that
 * form); the five client ones read the nearest XOSProvider.
 *
 * The product components a public page shows are here too, each rendering on the server with no
 * client module (lockstep issue 122): BrandMark, Card, DepartmentChip and Icon as `@xos/ui` exports
 * them, and Link and GateReadinessPanel as props-driven forms that take `locale` and `messages`
 * where the `@xos/ui` ones read the provider. MarketingPoints and PlanLimits draw the two lists the
 * cards use. The four that print no shared string take no locale.
 *
 * Styles: import "@xos/ui/marketing.css" after "@xos/ui/styles.css".
 */
export type * from "./Marketing/Marketing.types.ts";
export { marketingCopy, type MarketingCopy } from "./Marketing/marketing-copy.ts";
export { flattenMessages, type Messages } from "./lib/i18n.ts";
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
export { MarketingPoints } from "./Marketing/MarketingPoints.tsx";
export { PlanLimits } from "./Marketing/PlanLimits.tsx";
export { StaticLink as Link } from "./Marketing/StaticLink.tsx";
export { StaticGateReadinessPanel as GateReadinessPanel } from "./Marketing/StaticGateReadinessPanel.tsx";
export { BrandMark, monogram, type BrandMarkProps } from "./BrandMark/BrandMark.tsx";
export { Card, type CardProps } from "./Surface/Surface.tsx";
export { DepartmentChip } from "./Chips/DepartmentChip.tsx";
export { type DepartmentChipProps } from "./Chips/Chips.types.ts";
export { Icon, type IconProps } from "./Icon/Icon.tsx";
export { MarketingNav } from "./Marketing/MarketingNav.tsx";
export { PersonaSwitcher } from "./Marketing/PersonaSwitcher.tsx";
export { PricingTable } from "./Marketing/PricingTable.tsx";
export { CodeSample } from "./Marketing/CodeSample.tsx";
export { MarketingFooter } from "./Marketing/MarketingFooter.tsx";
