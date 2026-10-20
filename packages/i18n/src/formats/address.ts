import { formatAddress } from "localized-address-format";

/**
 * Postal addresses (Section 15): per-country formats and validation from Google's address metadata
 * (libaddressinput, the Address Data Service). Layout and line formatting come from
 * localized-address-format, which carries Google's format strings for every country; the postal
 * code patterns and required fields below are Google's `zip` and `require` values for the countries
 * XOS bills in and engages crew from most often. A country without an entry still formats; its
 * postal code is only checked for length.
 */

export type AddressField =
  | "recipient"
  | "organization"
  | "addressLines"
  | "dependentLocality"
  | "locality"
  | "administrativeArea"
  | "postalCode"
  | "sortingCode";

export interface PostalAddress {
  /** ISO 3166-1 alpha-2 country. */
  readonly country: string;
  readonly recipient?: string | null;
  readonly organization?: string | null;
  readonly addressLines?: readonly (string | null | undefined)[];
  readonly dependentLocality?: string | null;
  readonly locality?: string | null;
  /** State, province or prefecture, as its code or name. */
  readonly administrativeArea?: string | null;
  readonly postalCode?: string | null;
  readonly sortingCode?: string | null;
}

const CODE: Readonly<Record<string, AddressField>> = {
  N: "recipient",
  O: "organization",
  A: "addressLines",
  D: "dependentLocality",
  C: "locality",
  S: "administrativeArea",
  Z: "postalCode",
  X: "sortingCode",
};

interface CountryRules {
  /** Google `zip`: the postal code pattern, matched whole and case-insensitively. */
  readonly zip?: string;
  /** Google `require`: the fields an address must have, as N O A D C S Z X codes. */
  readonly require: string;
}

/** Google address metadata (`zip`, `require`). The GB pattern is the general outward and inward form. */
const RULES: Readonly<Record<string, CountryRules>> = {
  AT: { zip: "\\d{4}", require: "ACZ" },
  AU: { zip: "\\d{4}", require: "ACSZ" },
  BE: { zip: "\\d{4}", require: "ACZ" },
  BR: { zip: "\\d{5}-?\\d{3}", require: "ASCZ" },
  CA: {
    zip: "[ABCEGHJKLMNPRSTVXY]\\d[ABCEGHJ-NPRSTV-Z] ?\\d[ABCEGHJ-NPRSTV-Z]\\d",
    require: "ACSZ",
  },
  CH: { zip: "\\d{4}", require: "ACZ" },
  CN: { zip: "\\d{6}", require: "ACSZ" },
  DE: { zip: "\\d{5}", require: "ACZ" },
  DK: { zip: "\\d{4}", require: "ACZ" },
  ES: { zip: "\\d{5}", require: "ACSZ" },
  FI: { zip: "\\d{5}", require: "ACZ" },
  FR: { zip: "\\d{2} ?\\d{3}", require: "ACZ" },
  GB: {
    zip: "GIR ?0AA|[A-Z]{1,2}\\d[A-Z\\d]? ?\\d[ABD-HJLNP-UW-Z]{2}|BFPO ?\\d{1,4}",
    require: "ACZ",
  },
  IE: { zip: "[\\dA-Z]{3} ?[\\dA-Z]{4}", require: "AC" },
  IN: { zip: "\\d{6}", require: "ACSZ" },
  IT: { zip: "\\d{5}", require: "ACSZ" },
  JP: { zip: "\\d{3}-?\\d{4}", require: "ASZ" },
  KR: { zip: "\\d{5}", require: "ACSZ" },
  MX: { zip: "\\d{5}", require: "ACZ" },
  NL: { zip: "\\d{4} ?[A-Z]{2}", require: "ACZ" },
  NO: { zip: "\\d{4}", require: "ACZ" },
  NZ: { zip: "\\d{4}", require: "ACZ" },
  PL: { zip: "\\d{2}-\\d{3}", require: "ACZ" },
  PT: { zip: "\\d{4}-\\d{3}", require: "ACZ" },
  SE: { zip: "\\d{3} ?\\d{2}", require: "ACZ" },
  SG: { zip: "\\d{6}", require: "AZ" },
  US: { zip: "(\\d{5})(?:[ \\-](\\d{4}))?", require: "ACSZ" },
  ZA: { zip: "\\d{4}", require: "ACZ" },
};

const DEFAULT_RULES: CountryRules = { require: "AC" };

const upper = (country: string) => country.trim().toUpperCase();
const clean = (value: string | null | undefined) => value?.trim() ?? "";

/** The rows of an address form for a country, each row the fields it holds, in Google's order. */
export function addressLayout(country: string): AddressField[][] {
  const lines = formatAddress({
    postalCountry: upper(country),
    name: "\uE000N",
    organization: "\uE000O",
    addressLines: ["\uE000A"],
    dependentLocality: "\uE000D",
    locality: "\uE000C",
    administrativeArea: "\uE000S",
    postalCode: "\uE000Z",
    sortingCode: "\uE000X",
  });
  return lines
    .map((line) =>
      [...line.matchAll(/\uE000([NOADCSZX])/g)].map((m) => CODE[m[1] ?? ""] as AddressField),
    )
    .filter((row) => row.length > 0);
}

/** Fields a complete address in the country must have. */
export function requiredAddressFields(country: string): AddressField[] {
  const rules = RULES[upper(country)] ?? DEFAULT_RULES;
  return [...rules.require].map((c) => CODE[c] as AddressField);
}

/** True when the postal code fits the country's pattern; countries without one take 1 to 12 characters. */
export function isValidPostalCode(country: string, postalCode: string): boolean {
  const code = postalCode.trim();
  const zip = RULES[upper(country)]?.zip;
  if (!zip) return code.length >= 1 && code.length <= 12;
  return new RegExp(`^(?:${zip})$`, "i").test(code);
}

/** Required fields the address leaves empty, and the postal code when it does not fit the country. */
export function addressProblems(address: PostalAddress): AddressField[] {
  const value: Record<AddressField, string> = {
    recipient: clean(address.recipient),
    organization: clean(address.organization),
    addressLines: (address.addressLines ?? []).map(clean).join(""),
    dependentLocality: clean(address.dependentLocality),
    locality: clean(address.locality),
    administrativeArea: clean(address.administrativeArea),
    postalCode: clean(address.postalCode),
    sortingCode: clean(address.sortingCode),
  };
  const missing = requiredAddressFields(address.country).filter((f) => value[f] === "");
  if (value.postalCode !== "" && !isValidPostalCode(address.country, value.postalCode)) {
    missing.push("postalCode");
  }
  return missing;
}

/**
 * The address as lines in its country's format. The country name is added last, in the viewer's
 * language, when `withCountry` is true (for example when the viewer is in another country).
 */
export function formatPostalAddress(
  address: PostalAddress,
  options: { readonly locale: string; readonly withCountry?: boolean },
): string[] {
  const country = upper(address.country);
  const lines = formatAddress({
    postalCountry: country,
    name: clean(address.recipient),
    organization: clean(address.organization),
    addressLines: (address.addressLines ?? []).map(clean).filter((l) => l !== ""),
    dependentLocality: clean(address.dependentLocality),
    locality: clean(address.locality),
    administrativeArea: clean(address.administrativeArea),
    postalCode: clean(address.postalCode),
    sortingCode: clean(address.sortingCode),
  })
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (options.withCountry) {
    let name: string | undefined;
    try {
      name = new Intl.DisplayNames([options.locale], { type: "region" }).of(country);
    } catch {
      name = undefined;
    }
    lines.push(name ?? country);
  }
  return lines;
}
