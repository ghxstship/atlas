/**
 * Section 15 formats for people data: names, postal addresses and phone numbers. Import from
 * `@xos/i18n/formats` in server code; the phone metadata is too large for a client route bundle.
 */
export {
  composedName,
  compareNames,
  displayName,
  familyNameFirst,
  formalName,
  nameSortKey,
  shortName,
  type PersonName,
} from "./names.ts";
export {
  addressLayout,
  addressProblems,
  formatPostalAddress,
  isValidPostalCode,
  requiredAddressFields,
  type AddressField,
  type PostalAddress,
} from "./address.ts";
export { formatPhone, phoneCountry, phoneHref, regionFromLocale, toE164 } from "./phone.ts";
