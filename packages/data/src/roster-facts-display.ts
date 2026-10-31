import type { ProjectFactKind, RosterProjectFacts, ShoeSizeSystem } from "./roster-facts.ts";
import { workDetailLabelKey } from "./work-details.ts";

/**
 * What a roster entry holds for one project fact kind (R5), as labeled rows for display: Gateway's wizard and crew
 * drawer, Atlas's peek and Compass's cards show the same rows. Labels are `workDetails.projectFacts.*` keys read through
 * the caller's translator (scoped to the workDetails namespace); only values the caller was already given appear.
 */

/** The `workDetails.projectFacts.shoeSizeSystems.*` key of each sizing system (acronyms keep one case). */
export const SHOE_SIZE_SYSTEM_KEYS: Readonly<Record<ShoeSizeSystem, string>> = {
  "US Men": "usMen",
  "US Women": "usWomen",
  EU: "eu",
  UK: "uk",
};

type Translate = (key: string, values?: Record<string, string | number>) => string;

const F = "projectFacts.fields";

export function projectFactRows(
  t: Translate,
  kind: ProjectFactKind,
  facts: Pick<RosterProjectFacts, "travel" | "uniform" | "vehicle">,
): readonly (readonly [string, string])[] {
  const label = (name: string) => t(`${F}.${name}.label`);
  const yesNo = (v: boolean) => t(v ? "projectFacts.yes" : "projectFacts.no");
  const rows: [string, string | null][] = [];
  if (kind === "Travel" && facts.travel) {
    const v = facts.travel;
    const airport = (code: string | null, name: string | null) =>
      code ? (name ? `${name} (${code})` : code) : null;
    rows.push(
      [label("inboundAirport"), airport(v.inboundAirportCode, v.inboundAirportName)],
      [label("inboundOn"), v.inboundOn],
      [label("outboundAirport"), airport(v.outboundAirportCode, v.outboundAirportName)],
      [label("outboundOn"), v.outboundOn],
      [label("needsGroundTransport"), yesNo(v.needsGroundTransport)],
      [label("needsLodging"), yesNo(v.needsLodging)],
      [
        label("seatPreference"),
        v.seatPreference ? t(`seatPreferences.${workDetailLabelKey(v.seatPreference)}`) : null,
      ],
      [label("mealPreference"), v.mealPreference],
      [label("travelNotes"), v.travelNotes],
    );
  }
  if (kind === "Uniform" && facts.uniform) {
    const v = facts.uniform;
    rows.push(
      [label("shirtSize"), v.shirtSize],
      [label("jacketSize"), v.jacketSize],
      [label("pantsSize"), v.pantsSize],
      [
        label("shoeSize"),
        v.shoeSize !== null && v.shoeSizeSystem
          ? `${v.shoeSize} ${t(`projectFacts.shoeSizeSystems.${SHOE_SIZE_SYSTEM_KEYS[v.shoeSizeSystem]}`)}`
          : null,
      ],
      [label("gloveSize"), v.gloveSize],
      [label("hatSize"), v.hatSize],
      [label("pantsWaistIn"), v.pantsWaistIn === null ? null : String(v.pantsWaistIn)],
      [label("pantsInseamIn"), v.pantsInseamIn === null ? null : String(v.pantsInseamIn)],
    );
  }
  if (kind === "Vehicle" && facts.vehicle) {
    const v = facts.vehicle;
    rows.push(
      [label("make"), v.make],
      [label("model"), v.model],
      [label("color"), v.color],
      [label("plate"), v.plate],
      [label("plateRegion"), v.plateRegion],
    );
  }
  return rows.filter((r): r is [string, string] => r[1] !== null && r[1] !== "");
}
