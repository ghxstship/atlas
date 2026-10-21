import { useTranslations } from "next-intl";
import type { Translate } from "@/lib/shell/translate";

/** The `settings.automations` copy for the automation components, keyed below that namespace (A91). */
export function useAutomationCopy(): Translate {
  const t = useTranslations("settings.automations" as "settings");
  return (key, values) => (t as unknown as Translate)(key, values);
}
