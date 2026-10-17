import type { Messages } from "@xos/i18n";
import type { AtlasLocale } from "./i18n/negotiate";

/** Types next-intl's message keys and locales from the en-US source catalog (Section 15). */
declare module "next-intl" {
  interface AppConfig {
    Locale: AtlasLocale;
    Messages: Messages;
  }
}

/** The build's commit, inlined by next.config.ts as the release of browser error reports. */
declare global {
  namespace NodeJS {
    interface ProcessEnv {
      readonly NEXT_PUBLIC_XOS_RELEASE?: string;
    }
  }
}
