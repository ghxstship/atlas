import {
  MyAccessLogPanel,
  MySharingPanel,
  MyWorkDetailsPanel,
  NamePartsPanel,
} from "@/components/work-details/panels";
import type { SettingsContribution } from "./types";

/**
 * A78's settings panels (RRR-123, Section 4.5.6 items 1 and 10, Section 15):
 *   Settings, Work Details   emergency contacts, uniform sizes, dietary and accessibility needs, the
 *                            travel profile and passport; what each engagement sees; the access log
 *                            (the work phone is a registry setting above)
 *   Settings, Profile        optional given and family names beside the full name
 */
export const contributions: readonly SettingsContribution[] = [
  { node: "me.work-details", order: 10, Panel: MyWorkDetailsPanel },
  { node: "me.work-details", order: 20, Panel: MySharingPanel },
  { node: "me.work-details", order: 30, Panel: MyAccessLogPanel },
  { node: "me.profile", order: 15, Panel: NamePartsPanel },
];
