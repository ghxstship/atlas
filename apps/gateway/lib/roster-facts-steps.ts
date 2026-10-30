import {
  offeredFactKinds,
  type ProjectFactKind,
  type RosterFactChip,
  type RosterProjectFacts,
} from "@xos/data/roster-facts";

/**
 * The project facts wizard's plan (R5), pure so its rules are unit tested: a step for each kind the project offers,
 * then Review; in company mode a kind the person entered is shown read-only. Each step names its fields in order, and
 * the first seven show before More fields (Section 11.10).
 */

export type WizardMode = "person" | "company";

export interface WizardStep {
  readonly kind: ProjectFactKind | "Review";
  /** The company reads what the person entered and never changes it. */
  readonly readOnly: boolean;
}

export const MAX_VISIBLE_FIELDS = 7;

export function wizardSteps(
  facts: Pick<RosterProjectFacts, "offered" | "enteredByPerson" | "present">,
  mode: WizardMode,
): WizardStep[] {
  const steps: WizardStep[] = offeredFactKinds(facts.offered).map((kind) => ({
    kind,
    readOnly:
      mode === "company" && facts.present[byKind(kind)] && facts.enteredByPerson[byKind(kind)],
  }));
  return [...steps, { kind: "Review", readOnly: true }];
}

/** The key of a kind in the facts' per-kind flags. */
export function byKind(kind: ProjectFactKind): "travel" | "uniform" | "vehicle" {
  return kind === "Travel" ? "travel" : kind === "Uniform" ? "uniform" : "vehicle";
}

export interface StepFields {
  readonly visible: readonly string[];
  readonly more: readonly string[];
}

/** The form fields of a step, by name; the lodging question shows only while lodging is offered. */
export function stepFields(
  kind: ProjectFactKind,
  offered: RosterProjectFacts["offered"],
): StepFields {
  switch (kind) {
    case "Travel":
      return {
        visible: [
          "inboundAirportCode",
          "inboundOn",
          "outboundAirportCode",
          "outboundOn",
          "needsGroundTransport",
          ...(offered.lodging ? ["needsLodging"] : []),
          "seatPreference",
        ],
        more: ["mealPreference", "travelNotes"],
      };
    case "Uniform":
      return {
        visible: [
          "shirtSize",
          "jacketSize",
          "pantsSize",
          "shoeSize",
          "shoeSizeSystem",
          "gloveSize",
          "hatSize",
        ],
        more: ["pantsWaistIn", "pantsInseamIn"],
      };
    case "Vehicle":
      return { visible: ["make", "model", "color", "plate", "plateRegion"], more: [] };
  }
}

/** The StateChip state of a fact chip: on file reads as complete, missing as proposed, not offered as deferred. */
export function chipState(chip: RosterFactChip): "complete" | "proposed" | "deferred" {
  return chip === "onFile" ? "complete" : chip === "missing" ? "proposed" : "deferred";
}
