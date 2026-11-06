import { countryName } from "@xos/i18n/formats";
import { offeringPhrase } from "@xos/i18n/offering";
import { getLocale } from "next-intl/server";
import { currentOffering } from "@/lib/offering";

/**
 * What Gateway says about where XOS is offered (ADR 0160), in the reader's language. The names come from the database's
 * territories, so opening one changes these sentences with no code change.
 */

/** The offered territories as one phrase: "the United States". */
export async function offeredTerritoriesPhrase(): Promise<string> {
  const [offering, locale] = await Promise.all([currentOffering(), getLocale()]);
  return offeringPhrase(offering, locale);
}

/** The values of the refusal sentence for a country XOS is not offered in. */
export async function notOfferedValues(
  country: string,
): Promise<{ country: string; territories: string }> {
  const [offering, locale] = await Promise.all([currentOffering(), getLocale()]);
  return { country: countryName(country, locale), territories: offeringPhrase(offering, locale) };
}
