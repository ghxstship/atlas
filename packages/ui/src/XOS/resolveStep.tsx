import type { EmergencyAuthority } from "../types/reference";
import { type Translate } from "../lib/context.tsx";
import { SERVICES } from "./XOS.shared.tsx";

/** Resolves `{service}` tokens in a protocol step from the jurisdiction's agencies, or the generic service name. */
export function resolveStep(
  step: string,
  authorities: EmergencyAuthority[] | undefined,
  t: Translate,
): string {
  return step.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (!(SERVICES as string[]).includes(key)) return match;
    const agency = authorities?.find((a) => a.service === key);
    return agency ? agency.agency : t(`ecode.service.${key}`);
  });
}
