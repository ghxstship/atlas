import type { Messages } from "@xos/i18n";
import type { AtlasLocale } from "./i18n/negotiate";

/** Types next-intl's message keys and locales from the en-US source catalog (Section 15). */
declare module "next-intl" {
  interface AppConfig {
    Locale: AtlasLocale;
    Messages: Messages;
  }
}
