import type {
  AIDisclosureBadgeProps as ReferenceAIDisclosureBadgeProps,
  ButtonLinkProps as ReferenceButtonLinkProps,
  CodeSampleProps as ReferenceCodeSampleProps,
  ComparisonTableProps as ReferenceComparisonTableProps,
  ComparisonValue as ReferenceComparisonValue,
  FAQProps as ReferenceFAQProps,
  FeatureGridProps as ReferenceFeatureGridProps,
  GateLifecycleRailProps as ReferenceGateLifecycleRailProps,
  GateReadinessPanelProps as ReferenceGateReadinessPanelProps,
  IconName,
  LinkProps as ReferenceLinkProps,
  LogoSlotWallProps as ReferenceLogoSlotWallProps,
  MarketingFooterProps as ReferenceMarketingFooterProps,
  MarketingHeroProps as ReferenceMarketingHeroProps,
  MarketingLink as ReferenceMarketingLink,
  MarketingNavProps as ReferenceMarketingNavProps,
  MarketingSectionProps as ReferenceMarketingSectionProps,
  Persona as ReferencePersona,
  PersonaSwitcherProps as ReferencePersonaSwitcherProps,
  PriceDisplayProps as ReferencePriceDisplayProps,
  PricingPlan as ReferencePricingPlan,
  PricingTableProps as ReferencePricingTableProps,
  ProofStatStripProps as ReferenceProofStatStripProps,
  ScreenshotFrameProps as ReferenceScreenshotFrameProps,
  SurfaceTriptychProps as ReferenceSurfaceTriptychProps,
  TestimonialProps as ReferenceTestimonialProps,
} from "../types/reference";
import type { Messages } from "../lib/i18n.ts";

/**
 * The locale of a component rendered without a provider. The Marketing components that hold no
 * state render on the server, where no XOSProvider is in reach, so the page passes its locale and
 * that locale's `ui` messages to each one that prints a shared string or formats a number. Left
 * out, they read what `configure` set, en-US by default.
 */
export interface MarketingLocaleProps {
  /** BCP 47 locale for the shared strings and Intl formatting. */
  locale?: string;
  /** Flat `ui` messages for that locale, keyed without the namespace; missing keys read en-US. */
  messages?: Messages;
}

export type MarketingLink = ReferenceMarketingLink;
export type Persona = ReferencePersona;
export type PricingPlan = ReferencePricingPlan;
export type ComparisonValue = ReferenceComparisonValue;

export type ButtonLinkProps = ReferenceButtonLinkProps;
export type MarketingNavProps = ReferenceMarketingNavProps;
export type MarketingSectionProps = ReferenceMarketingSectionProps;
export type MarketingHeroProps = ReferenceMarketingHeroProps;
export type ScreenshotFrameProps = ReferenceScreenshotFrameProps;
export type PersonaSwitcherProps = ReferencePersonaSwitcherProps;
export type ProofStatStripProps = ReferenceProofStatStripProps & MarketingLocaleProps;
export type GateLifecycleRailProps = ReferenceGateLifecycleRailProps & MarketingLocaleProps;
export type SurfaceTriptychProps = ReferenceSurfaceTriptychProps;
export type FeatureGridProps = ReferenceFeatureGridProps & MarketingLocaleProps;
export type ComparisonTableProps = ReferenceComparisonTableProps & MarketingLocaleProps;
export type PriceDisplayProps = ReferencePriceDisplayProps & MarketingLocaleProps;
export type PricingTableProps = ReferencePricingTableProps;
export type FAQProps = ReferenceFAQProps;
export type TestimonialProps = ReferenceTestimonialProps;
export type LogoSlotWallProps = ReferenceLogoSlotWallProps & MarketingLocaleProps;
export type AIDisclosureBadgeProps = ReferenceAIDisclosureBadgeProps & MarketingLocaleProps;
export type CodeSampleProps = ReferenceCodeSampleProps;

/** Link rendered on the server: the reference props and the page's locale for the new-tab label. */
export type StaticLinkProps = ReferenceLinkProps & MarketingLocaleProps;

/**
 * GateReadinessPanel rendered on the server: the reference props and the page's locale. It takes no
 * handlers, because a function cannot cross from a server component to the browser.
 */
export type StaticGateReadinessPanelProps = ReferenceGateReadinessPanelProps & MarketingLocaleProps;

export interface MarketingPointsProps {
  /** The claims, one line each. */
  points: string[];
  /** The registered icon that leads every point; a check by default. */
  icon?: IconName;
  /** The icon's color as a CSS value such as `var(--color-text-secondary)`; success by default. */
  iconColor?: string;
}

export interface PlanLimitsProps {
  /** The rows in order: a label and the value it reads at the end of the row. */
  limits: { label: string; value: string }[];
}
export type MarketingFooterProps = ReferenceMarketingFooterProps;
