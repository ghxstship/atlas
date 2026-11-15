import type { FeatureOffering, PlanOffering, SaleOffering } from "./model.ts";
import { PLAN_OFFERING } from "./offering.generated.ts";

/**
 * What is offered and on sale today, read from the offering section of plans.yaml (ADR 0035, 2026-11-15 amendment).
 * This module is plain data and pure functions, so every shell and the marketing site can import it: it reads no
 * file and needs no Node API. The statuses decide what a price list shows. They never decide an entitlement, which
 * stays with private.plan_features, or a price, which stays with the price books.
 */
export { PLAN_OFFERING };

/** How plans.yaml states a feature, or undefined for a code the registry does not list. */
export function planFeatureOffering(
  feature: string,
  offering: PlanOffering = PLAN_OFFERING,
): FeatureOffering | undefined {
  return Object.hasOwn(offering.features, feature) ? offering.features[feature] : undefined;
}

/**
 * True when a price list may show the feature. `openTerritories` holds the codes of the territories open in
 * private.territories (ADR 0160); a caller that cannot read them passes none, and a territory feature then reads
 * as not offered. A code the registry does not list is not offered.
 */
export function isPlanFeatureOffered(
  feature: string,
  openTerritories: readonly string[] = [],
  offering: PlanOffering = PLAN_OFFERING,
): boolean {
  const stated = planFeatureOffering(feature, offering);
  if (stated === undefined) return false;
  if (stated.status === "offered") return true;
  return (
    stated.status === "territory" &&
    stated.territory !== null &&
    openTerritories.includes(stated.territory)
  );
}

/** The features of a list a price list may show, in the order given. */
export function offeredPlanFeatures(
  features: readonly string[],
  openTerritories: readonly string[] = [],
  offering: PlanOffering = PLAN_OFFERING,
): string[] {
  return features.filter((f) => isPlanFeatureOffered(f, openTerritories, offering));
}

/** True when a customer can buy extra seats today, on a plan that prices them. */
export function extraSeatsOnSale(offering: PlanOffering = PLAN_OFFERING): boolean {
  return offering.extraSeats.status === "on_sale";
}

/** How plans.yaml states an add-on, or undefined for a code the registry does not list. */
export function addonOffering(
  code: string,
  offering: PlanOffering = PLAN_OFFERING,
): SaleOffering | undefined {
  return Object.hasOwn(offering.addons, code) ? offering.addons[code] : undefined;
}

/** True when a customer can buy the add-on today. A code the registry does not list is not on sale. */
export function addonOnSale(code: string, offering: PlanOffering = PLAN_OFFERING): boolean {
  return addonOffering(code, offering)?.status === "on_sale";
}
