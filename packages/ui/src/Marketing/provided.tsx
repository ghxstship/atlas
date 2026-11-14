"use client";

import { type ReactElement } from "react";
import { useLocale, useMessages } from "../lib/context.tsx";
import { AIDisclosureBadge as StaticAIDisclosureBadge } from "./AIDisclosureBadge.tsx";
import { ComparisonTable as StaticComparisonTable } from "./ComparisonTable.tsx";
import { FeatureGrid as StaticFeatureGrid } from "./FeatureGrid.tsx";
import { GateLifecycleRail as StaticGateLifecycleRail } from "./GateLifecycleRail.tsx";
import { LogoSlotWall as StaticLogoSlotWall } from "./LogoSlotWall.tsx";
import { PriceDisplay as StaticPriceDisplay } from "./PriceDisplay.tsx";
import { ProofStatStrip as StaticProofStatStrip } from "./ProofStatStrip.tsx";
import { type MarketingLocaleProps } from "./Marketing.types.ts";

/**
 * The Marketing components that print a shared string or format a number, bound to the nearest
 * XOSProvider. `@xos/ui` exports these, so inside a product shell they follow its locale like every
 * other component. `@xos/ui/marketing` exports the plain ones, which a server component renders
 * with the page's `locale` and `messages`.
 */
function provided<P extends MarketingLocaleProps>(
  Component: (props: P) => ReactElement | null,
): (props: P) => ReactElement | null {
  return function Provided(props: P): ReactElement | null {
    const locale = useLocale();
    const messages = useMessages();
    return <Component {...({ locale, messages, ...props } as P)} />;
  };
}

export const ProofStatStrip = provided(StaticProofStatStrip);
export const GateLifecycleRail = provided(StaticGateLifecycleRail);
export const FeatureGrid = provided(StaticFeatureGrid);
export const ComparisonTable = provided(StaticComparisonTable);
export const PriceDisplay = provided(StaticPriceDisplay);
export const LogoSlotWall = provided(StaticLogoSlotWall);
export const AIDisclosureBadge = provided(StaticAIDisclosureBadge);
