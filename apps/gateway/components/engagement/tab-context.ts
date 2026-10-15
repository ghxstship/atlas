import type { EngagementView } from "@/lib/engagement";
import type { Translate } from "@/lib/shell/translate";

/** What every engagement tab renders from: the engagement view, the translator and the locale. */
export interface TabProps {
  readonly view: EngagementView;
  readonly t: Translate;
  readonly locale: string;
  readonly engagementKey: string;
}
