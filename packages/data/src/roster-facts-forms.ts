import type { DataError } from "./result.ts";
import {
  ROSTER_FACT_RULES,
  SHOE_SIZE_SYSTEMS,
  type RosterTravelInput,
  type RosterUniformInput,
  type RosterVehicleInput,
} from "./roster-facts.ts";
import { GARMENT_LETTER_SIZES, SEAT_PREFERENCES } from "./work-details.ts";
import type { Parsed } from "./work-details-forms.ts";

/**
 * The project facts forms of Gateway and Compass (R5) read the same fields, so their actions share these parsers: each
 * turns submitted FormData into the repository input, or names the fields to fix. They check what the database checks,
 * so most mistakes are named before a round trip; the RPCs stay the authority. Errors map to `workDetails.errors.*` keys
 * with `rosterFactErrorKey`.
 */

const AIRPORT = /^[A-Z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PLATE = /^[A-Z0-9]{1,10}$/;
const PLATE_REGION = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;

const good = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = <T>(fields: readonly string[]): Parsed<T> => ({ ok: false, fields, code: "invalid" });

function raw(form: FormData, name: string): string {
  const value = form.get(name);
  return value === null ? "" : String(value).trim();
}

function textOrNull(form: FormData, name: string, max: number, problems: string[]): string | null {
  const value = raw(form, name);
  if (value === "") return null;
  if (value.length > max) problems.push(name);
  return value;
}

function pick<T extends string>(allowed: readonly T[], value: string): T | null {
  return (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

const checked = (form: FormData, name: string) => {
  const value = form.get(name);
  return value === "on" || value === "true" || value === "1";
};

/** An airport code as the database stores it: trimmed and uppercased. */
export function normalizeAirportCode(value: string): string {
  return value.trim().toUpperCase();
}

/** A plate as the database stores it: uppercased with spaces and hyphens removed. */
export function normalizePlate(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

export function parseRosterTravelForm(form: FormData): Parsed<RosterTravelInput> {
  const problems: string[] = [];
  const airport = (name: string) => {
    const value = normalizeAirportCode(raw(form, name));
    if (value === "") return null;
    if (!AIRPORT.test(value)) problems.push(name);
    return value;
  };
  const date = (name: string) => {
    const value = raw(form, name);
    if (value === "") return null;
    if (!DATE.test(value)) problems.push(name);
    return value;
  };
  const value: RosterTravelInput = {
    inboundAirportCode: airport("inboundAirportCode"),
    outboundAirportCode: airport("outboundAirportCode"),
    inboundOn: date("inboundOn"),
    outboundOn: date("outboundOn"),
    seatPreference: pick(SEAT_PREFERENCES, raw(form, "seatPreference")),
    mealPreference: textOrNull(form, "mealPreference", 100, problems),
    needsGroundTransport: checked(form, "needsGroundTransport"),
    needsLodging: checked(form, "needsLodging"),
    travelNotes: textOrNull(form, "travelNotes", 500, problems),
  };
  if (value.inboundOn && value.outboundOn && value.outboundOn < value.inboundOn)
    problems.push("outboundOn");
  if (
    !value.inboundAirportCode &&
    !value.outboundAirportCode &&
    !value.inboundOn &&
    !value.outboundOn
  ) {
    problems.push("inboundAirportCode", "inboundOn");
  }
  return problems.length > 0 ? bad(problems) : good(value);
}

export function parseRosterUniformForm(form: FormData): Parsed<RosterUniformInput> {
  const problems: string[] = [];
  const size = (name: string) => pick(GARMENT_LETTER_SIZES, raw(form, name));
  const inches = (name: string, min: number, max: number) => {
    const value = raw(form, name);
    if (value === "") return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) problems.push(name);
    return n;
  };
  const shoeRaw = raw(form, "shoeSize");
  let shoeSize: number | null = null;
  if (shoeRaw !== "") {
    shoeSize = Number(shoeRaw);
    if (
      !Number.isFinite(shoeSize) ||
      shoeSize < 1 ||
      shoeSize > 20 ||
      shoeSize * 2 !== Math.trunc(shoeSize * 2)
    ) {
      problems.push("shoeSize");
    }
  }
  const shoeSizeSystem = pick(SHOE_SIZE_SYSTEMS, raw(form, "shoeSizeSystem"));
  if ((shoeSize === null) !== (shoeSizeSystem === null))
    problems.push(shoeSize === null ? "shoeSize" : "shoeSizeSystem");
  const value: RosterUniformInput = {
    shirtSize: size("shirtSize"),
    jacketSize: size("jacketSize"),
    pantsSize: size("pantsSize"),
    gloveSize: size("gloveSize"),
    hatSize: size("hatSize"),
    pantsWaistIn: inches("pantsWaistIn", 20, 70),
    pantsInseamIn: inches("pantsInseamIn", 20, 40),
    shoeSize,
    shoeSizeSystem,
  };
  const given = [
    value.shirtSize,
    value.jacketSize,
    value.pantsSize,
    value.gloveSize,
    value.hatSize,
    value.pantsWaistIn,
    value.pantsInseamIn,
    value.shoeSize,
  ].some((v) => v !== null);
  if (!given) problems.push("shirtSize");
  return problems.length > 0 ? bad([...new Set(problems)]) : good(value);
}

export function parseRosterVehicleForm(form: FormData): Parsed<RosterVehicleInput> {
  const problems: string[] = [];
  const required = (name: string, max: number) => {
    const value = raw(form, name);
    if (value === "" || value.length > max) problems.push(name);
    return value;
  };
  const make = required("make", 60);
  const model = required("model", 60);
  const color = textOrNull(form, "color", 30, problems);
  const plate = normalizePlate(raw(form, "plate"));
  if (!PLATE.test(plate)) problems.push("plate");
  const plateRegion = raw(form, "plateRegion").toUpperCase();
  if (!PLATE_REGION.test(plateRegion)) problems.push("plateRegion");
  return problems.length > 0 ? bad(problems) : good({ make, model, color, plate, plateRegion });
}

const RULES = new Set<string>(ROSTER_FACT_RULES);

/** The `workDetails.errors.*` key of a project fact error; unknown refusals are `unexpected`. */
export function rosterFactErrorKey(error: DataError): string {
  if (error.kind === "refusal") return RULES.has(error.rule) ? error.rule : "unexpected";
  if (error.kind === "not-found") return "denied";
  if (error.kind === "conflict") return "conflict";
  if (error.kind === "invalid") return "invalid";
  return "unexpected";
}
