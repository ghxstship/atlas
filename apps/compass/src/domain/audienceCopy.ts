/**
 * Copy that depends on who is reading it (C-17). Open shifts, timesheet approvals, delegates, the org directory and
 * Atlas's own settings belong to an organization's members; an artist, a vendor, a client or a sponsor was told to
 * claim open shifts, to approve timesheets from the alert, or what the page Atlas opens after sign-in is.
 */
import { isInternal, type Audience } from "@xos/sync";

/** Today's empty shift list: members are pointed at open shifts, external people at what they are booked for. */
export function noShiftsKey(audience: Audience): string {
  return isInternal(audience) ? "compass.today.noShifts" : "compass.today.noShiftsExternal";
}

export interface NotificationPromptKeys {
  readonly title: string;
  readonly prompt: string;
  readonly denied: string;
}

/** The Inbox card that asks for notifications: approving from the alert only for someone who approves timesheets. */
export function notificationPromptKeys(approvesTimesheets: boolean): NotificationPromptKeys {
  return approvesTimesheets
    ? {
        title: "compass.notifications.promptTitle",
        prompt: "compass.notifications.prompt",
        denied: "compass.notifications.denied",
      }
    : {
        title: "compass.notifications.promptTitleGeneral",
        prompt: "compass.notifications.promptGeneral",
        denied: "compass.notifications.deniedGeneral",
      };
}

/**
 * Registered settings only Atlas reads: its start page, its list density and the sidebar persona. An external
 * person works in Gateway and Compass, never Atlas, so their Preferences leave these out.
 */
export const ATLAS_ONLY_SETTINGS: ReadonlySet<string> = new Set([
  "shell.start_page",
  "shell.density",
  "me.persona",
]);

/** Help that speaks of a member's delegate or the org directory, in the words for an external person. */
const EXTERNAL_HELP: Readonly<Record<string, string>> = {
  "me.out_of_office.enabled": "compassPersonal.registry.externalHelp.outOfOffice",
  "workforce.work_phone": "compassPersonal.registry.externalHelp.workPhone",
};

interface HasKeyAndHelp {
  readonly key: string;
  readonly help?: string | null | undefined;
}

/** A section's settings as the audience should see them: Atlas-only ones left out, and help in their words. */
export function settingsForAudience<T extends HasKeyAndHelp>(
  defs: readonly T[],
  audience: Audience | null,
): T[] {
  if (audience === null || isInternal(audience)) return [...defs];
  return defs
    .filter((d) => !ATLAS_ONLY_SETTINGS.has(d.key))
    .map((d) => {
      const help = EXTERNAL_HELP[d.key];
      return help ? { ...d, help } : d;
    });
}
