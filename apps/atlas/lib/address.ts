import {
  addressLayout,
  addressProblems,
  formatPostalAddress,
  normalizePostalCode,
  requiredAddressFields,
  type AddressField,
} from "@xos/i18n/formats";

/**
 * Postal addresses in Atlas forms (Section 15, A139): venue, vendor and legal entity addresses lay out
 * and validate by country from Google's address metadata (@xos/i18n/formats). The layout is computed on
 * the server and handed to the form, so no address metadata reaches the browser. The database checks
 * the postal code again with the same patterns (migration 2320).
 */

/** The address fields Atlas records; recipient, organization and sorting code live elsewhere or nowhere. */
export type AddressInput = "streetAddress" | "locality" | "administrativeArea" | "postalCode";

export interface AddressFormat {
  readonly country: string;
  /** Rows of the form in the country's order, each the fields it holds. */
  readonly rows: readonly (readonly AddressInput[])[];
  readonly required: readonly AddressInput[];
}

export interface AddressValue {
  readonly streetAddress: string | null;
  readonly locality: string | null;
  readonly administrativeArea: string | null;
  readonly postalCode: string | null;
}

export const NO_ADDRESS: AddressValue = {
  streetAddress: null,
  locality: null,
  administrativeArea: null,
  postalCode: null,
};

const INPUT: Partial<Record<AddressField, AddressInput>> = {
  addressLines: "streetAddress",
  locality: "locality",
  administrativeArea: "administrativeArea",
  postalCode: "postalCode",
};

const MAX: Readonly<Record<AddressInput, number>> = {
  streetAddress: 200,
  locality: 100,
  administrativeArea: 100,
  postalCode: 12,
};

const toInputs = (fields: readonly AddressField[], omit: readonly AddressInput[]) =>
  fields
    .map((f) => INPUT[f])
    .filter((f): f is AddressInput => f !== undefined && !omit.includes(f));

/**
 * The address form of a country. `omit` drops fields a record takes from elsewhere, as a venue takes its
 * state from its jurisdiction.
 */
export function addressFormat(country: string, omit: readonly AddressInput[] = []): AddressFormat {
  return {
    country: country.toUpperCase(),
    rows: addressLayout(country)
      .map((row) => toInputs(row, omit))
      .filter((row) => row.length > 0),
    required: toInputs(requiredAddressFields(country), omit),
  };
}

export type AddressRead =
  | { readonly ok: true; readonly value: AddressValue }
  | {
      readonly ok: false;
      readonly problems: Readonly<Partial<Record<AddressInput, AddressProblem>>>;
    };

/** `required`: the country needs the field; `postalCode`: the code does not fit; `tooLong`. */
export type AddressProblem = "required" | "postalCode" | "tooLong";

/** The field error key of each problem, which every module's catalog names. */
export const ADDRESS_ERROR: Readonly<Record<AddressProblem, string>> = {
  required: "addressRequired",
  postalCode: "postalCode",
  tooLong: "addressTooLong",
};

function field(form: FormData, name: string): string | null {
  const value = form.get(name);
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Reads the address fields of a submitted form for a country. An address left wholly blank is not
 * recorded (every field null); one that is started must have what the country requires and a postal
 * code that fits, which is written the way the country writes it. With no country known, only lengths
 * are checked.
 */
export function readAddress(
  form: FormData,
  country: string | null,
  omit: readonly AddressInput[] = [],
): AddressRead {
  const read = (name: AddressInput) => (omit.includes(name) ? null : field(form, name));
  const raw: AddressValue = {
    streetAddress: read("streetAddress"),
    locality: read("locality"),
    administrativeArea: read("administrativeArea"),
    postalCode: read("postalCode"),
  };
  const value: AddressValue =
    country && raw.postalCode
      ? { ...raw, postalCode: normalizePostalCode(country, raw.postalCode) }
      : raw;
  const problems: Partial<Record<AddressInput, AddressProblem>> = {};
  for (const name of Object.keys(MAX) as AddressInput[]) {
    if ((value[name]?.length ?? 0) > MAX[name]) problems[name] = "tooLong";
  }
  const started = Object.values(value).some((v) => v !== null);
  if (country && started) {
    const found = addressProblems({
      country,
      addressLines: [value.streetAddress],
      locality: value.locality,
      administrativeArea: value.administrativeArea,
      postalCode: value.postalCode,
    });
    for (const name of toInputs(found, omit)) {
      problems[name] ??= name === "postalCode" && value.postalCode ? "postalCode" : "required";
    }
  }
  return Object.keys(problems).length > 0 ? { ok: false, problems } : { ok: true, value };
}

/**
 * The address as lines in its country's format, or null when none is recorded. The country name is
 * added when it is not the viewer's.
 */
export function addressLines(
  value: AddressValue,
  country: string | null,
  options: { readonly locale: string; readonly viewerCountry?: string | null },
): string[] | null {
  if (!country || Object.values(value).every((v) => v === null)) return null;
  const lines = formatPostalAddress(
    {
      country,
      addressLines: [value.streetAddress],
      locality: value.locality,
      administrativeArea: value.administrativeArea,
      postalCode: value.postalCode,
    },
    {
      locale: options.locale,
      withCountry: country.toUpperCase() !== (options.viewerCountry ?? "").toUpperCase(),
    },
  );
  return lines.length > 0 ? lines : null;
}
