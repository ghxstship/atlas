import type { Messages } from "@xos/i18n";
import type { Locale } from "@xos/i18n/locales";

/** Types next-intl's message keys and locales from the en-US source catalog (Section 15). */
declare module "next-intl" {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
