import type { LocalContact } from "@xos/data/local-contacts";
import { formatPhone, regionFromLocale, toE164 } from "@xos/i18n/formats";
import type { ShownContact } from "./panel";

/**
 * Phones for the local contacts panel, worked out on the server so the browser never loads the phone metadata: the
 * number in national format for the viewer's region, and its E.164 form for a tel: link only when it dials. A work
 * phone stored before A139 normalizes it may not be E.164; it shows as typed, with no call button.
 */
export function shownContacts(contacts: readonly LocalContact[], locale: string): ShownContact[] {
  const region = regionFromLocale(locale);
  return contacts.map((c) => {
    const tel = c.phone ? toE164(c.phone, region) : null;
    return { ...c, tel, phoneDisplay: c.phone ? (tel ? formatPhone(tel, region) : c.phone) : null };
  });
}
