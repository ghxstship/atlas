import { countryName, countryOptions } from "@xos/i18n/formats";
import { offeringNames, type Offering } from "@xos/i18n/offering";
import { getLocale } from "next-intl/server";
import { currentOffering } from "@/lib/offering";

/**
 * What signup says about where XOS is offered (ADR 0156), in the reader's language. The names come from the database's
 * territories, so opening one changes these sentences with no code change.
 */

function namesIn(offering: Offering, locale: string): string {
  return new Intl.ListFormat(locale, { type: "conjunction" }).format(
    offeringNames(offering, locale),
  );
}

/** The offered territories as one phrase: "the United States". */
export async function offeredTerritoriesPhrase(): Promise<string> {
  const [offering, locale] = await Promise.all([currentOffering(), getLocale()]);
  return namesIn(offering, locale);
}

/** Every country, for the question signup asks. Which ones are offered stays on the server. */
export async function signupCountryOptions(): Promise<{ value: string; label: string }[]> {
  return countryOptions(await getLocale());
}

/** The values of the refusal sentence for a country XOS is not offered in. */
export async function notOfferedValues(
  country: string,
): Promise<{ country: string; territories: string }> {
  const [offering, locale] = await Promise.all([currentOffering(), getLocale()]);
  return { country: countryName(country, locale), territories: namesIn(offering, locale) };
}
