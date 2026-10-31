/**
 * Project details in Compass (R5, ADR 0100 decision 7 and ADR 0071 decision 5): the travel request, uniform sizes and
 * vehicle the person enters on their own roster entry. Cards follow what the project offers. Every save goes to the
 * server with the person's session, checked first by the parsers Gateway shares (@xos/data/roster-facts-forms); a
 * project fact is never queued, cached or kept on the phone, so offline the save buttons are disabled.
 */
import type { XosClient } from "@xos/data";
import type { Result } from "@xos/data/result";
import {
  offeredFactKinds,
  saveRosterTravelRequest,
  saveRosterUniformSizes,
  saveRosterVehicle,
  type ProjectFactKind,
  type RosterProjectFacts,
} from "@xos/data/roster-facts";
import {
  parseRosterTravelForm,
  parseRosterUniformForm,
  parseRosterVehicleForm,
  rosterFactErrorKey,
} from "@xos/data/roster-facts-forms";
import type { MyRosterEntry } from "@xos/data/roster";
import { formFields } from "../settings/workDetails";

/** The cards an entry shows: one per offered kind, in the wizard's order. */
export function projectDetailCards(facts: Pick<RosterProjectFacts, "offered">): ProjectFactKind[] {
  return offeredFactKinds(facts.offered);
}

/** The entries the list shows: live ones the person has not declined. */
export function liveEntries(rows: readonly MyRosterEntry[]): MyRosterEntry[] {
  return rows.filter((r) => r.entryState !== "Withdrawn" && r.personResponse !== "Declined");
}

/** A card's form as last saved, every field as text ("on" for a checked box). */
export function factFields(
  kind: ProjectFactKind,
  facts: Pick<RosterProjectFacts, "travel" | "uniform" | "vehicle">,
): Record<string, string> {
  const s = (v: string | number | null | undefined) =>
    v === null || v === undefined ? "" : String(v);
  if (kind === "Travel") {
    const v = facts.travel;
    return {
      inboundAirportCode: s(v?.inboundAirportCode),
      inboundOn: s(v?.inboundOn),
      outboundAirportCode: s(v?.outboundAirportCode),
      outboundOn: s(v?.outboundOn),
      needsGroundTransport: v?.needsGroundTransport ? "on" : "",
      needsLodging: v?.needsLodging ? "on" : "",
      seatPreference: s(v?.seatPreference),
      mealPreference: s(v?.mealPreference),
      travelNotes: s(v?.travelNotes),
    };
  }
  if (kind === "Uniform") {
    const v = facts.uniform;
    return {
      shirtSize: s(v?.shirtSize),
      jacketSize: s(v?.jacketSize),
      pantsSize: s(v?.pantsSize),
      shoeSize: s(v?.shoeSize),
      shoeSizeSystem: s(v?.shoeSizeSystem),
      gloveSize: s(v?.gloveSize),
      hatSize: s(v?.hatSize),
      pantsWaistIn: s(v?.pantsWaistIn),
      pantsInseamIn: s(v?.pantsInseamIn),
    };
  }
  const v = facts.vehicle;
  return {
    make: s(v?.make),
    model: s(v?.model),
    color: s(v?.color),
    plate: s(v?.plate),
    plateRegion: s(v?.plateRegion),
  };
}

export type FactSave =
  | { readonly kind: "saved" }
  | { readonly kind: "invalid"; readonly fields: Readonly<Record<string, string>> }
  | { readonly kind: "failed"; readonly key: string };

/**
 * Saves one card online: parse, then the repository's RPC with the person's session. Offline the caller never calls
 * this (the button is disabled), and nothing here queues.
 */
export async function saveProjectFact(
  db: XosClient,
  rosterEntryId: string,
  kind: ProjectFactKind,
  values: Readonly<Record<string, string>>,
): Promise<FactSave> {
  const form = formFields(values);
  let result: Result<string>;
  if (kind === "Travel") {
    const parsed = parseRosterTravelForm(form);
    if (!parsed.ok) return invalid(parsed.fields, parsed.code);
    result = await saveRosterTravelRequest(db, rosterEntryId, parsed.value);
  } else if (kind === "Uniform") {
    const parsed = parseRosterUniformForm(form);
    if (!parsed.ok) return invalid(parsed.fields, parsed.code);
    result = await saveRosterUniformSizes(db, rosterEntryId, parsed.value);
  } else {
    const parsed = parseRosterVehicleForm(form);
    if (!parsed.ok) return invalid(parsed.fields, parsed.code);
    result = await saveRosterVehicle(db, rosterEntryId, parsed.value);
  }
  return result.ok
    ? { kind: "saved" }
    : { kind: "failed", key: `workDetails.errors.${rosterFactErrorKey(result.error)}` };
}

function invalid(fields: readonly string[], code: string): FactSave {
  return {
    kind: "invalid",
    fields: Object.fromEntries(fields.map((f) => [f, `workDetails.errors.${code}`])),
  };
}
