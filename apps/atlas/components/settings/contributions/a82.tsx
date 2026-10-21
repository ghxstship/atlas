import { getMemberNoticeSubscription } from "@xos/data/subprocessor-notices";
import { Button, Checkbox } from "@/components/ui";
import { setMemberNoticeAction } from "@/lib/privacy/subprocessor-actions";
import { getTranslate } from "@/lib/shell/translate";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A82's settings panels (RRR-127, Section 14.4, finding A65-014):
 *   Me, Notifications   Subprocessor List change notices, which Owners and Admins of a customer org
 *                       receive by default (legal/subprocessors.md section 1, migration 1382); shown
 *                       only to them
 */

async function SubprocessorNoticePanel({ ctx }: SettingsPanelProps) {
  const subscription = await getMemberNoticeSubscription(ctx.viewer.db);
  if (!subscription.ok || !subscription.data.eligible) return null;
  const t = await getTranslate();
  return (
    <section aria-labelledby="subprocessor-notices-heading" className="flex flex-col gap-12">
      <header className="flex flex-col gap-4">
        <h2 id="subprocessor-notices-heading" className="m-0 text-heading-16 font-semibold">
          {t("compliance.subprocessors.settings.title")}
        </h2>
        <p className="m-0 text-text-secondary">{t("compliance.subprocessors.settings.lead")}</p>
      </header>
      <form action={setMemberNoticeAction} className="flex flex-col gap-12">
        <input type="hidden" name="org" value={ctx.org.slug} />
        <Checkbox
          name="subscribed"
          defaultChecked={subscription.data.subscribed}
          label={t("compliance.subprocessors.settings.label")}
        />
        <div>
          <Button type="submit" variant="secondary">
            {t("compliance.subprocessors.settings.save")}
          </Button>
        </div>
      </form>
    </section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "me.notifications", order: 80, Panel: SubprocessorNoticePanel },
];
