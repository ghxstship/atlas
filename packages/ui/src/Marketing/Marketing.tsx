/* The Marketing layer as `@xos/ui` exports it: inside a product shell every component follows the
   nearest XOSProvider. Public pages import from `@xos/ui/marketing` instead (src/marketing.ts). */
export type {
  MarketingLocaleProps,
  MarketingLink,
  Persona,
  PricingPlan,
  ComparisonValue,
  ButtonLinkProps,
  MarketingNavProps,
  MarketingSectionProps,
  MarketingHeroProps,
  ScreenshotFrameProps,
  PersonaSwitcherProps,
  ProofStatStripProps,
  GateLifecycleRailProps,
  SurfaceTriptychProps,
  FeatureGridProps,
  ComparisonTableProps,
  PriceDisplayProps,
  PricingTableProps,
  FAQProps,
  TestimonialProps,
  LogoSlotWallProps,
  AIDisclosureBadgeProps,
  CodeSampleProps,
  MarketingFooterProps,
} from "./Marketing.types.ts";
export { ButtonLink } from "./ButtonLink.tsx";
export { MarketingNav } from "./MarketingNav.tsx";
export { MarketingSection } from "./MarketingSection.tsx";
export { MarketingHero } from "./MarketingHero.tsx";
export { ScreenshotFrame } from "./ScreenshotFrame.tsx";
export { PersonaSwitcher } from "./PersonaSwitcher.tsx";
export { SurfaceTriptych } from "./SurfaceTriptych.tsx";
export { PricingTable } from "./PricingTable.tsx";
export { FAQ } from "./FAQ.tsx";
export { Testimonial } from "./Testimonial.tsx";
export { CodeSample } from "./CodeSample.tsx";
export { MarketingFooter } from "./MarketingFooter.tsx";
export {
  ProofStatStrip,
  GateLifecycleRail,
  FeatureGrid,
  ComparisonTable,
  PriceDisplay,
  LogoSlotWall,
  AIDisclosureBadge,
} from "./provided.tsx";
