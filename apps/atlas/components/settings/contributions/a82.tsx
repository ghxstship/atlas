import { listPendingReacceptances } from "@xos/data/legal-reacceptance";
import { getMemberNoticeSubscription } from "@xos/data/subprocessor-notices";
import type { Route } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { CertifiedPayrollPanel } from "@/components/compliance/certified-payroll-panel";
import { OshaEstablishmentsPanel } from "@/components/compliance/osha-panels";
import { documentTitle, legalDate } from "@/components/legal/reacceptance-banner";
import { Button, Checkbox } from "@/components/ui";
import { acceptLegalChangeAction } from "@/lib/legal/reacceptance-actions";
import { setMemberNoticeAction } from "@/lib/privacy/subprocessor-actions";
import { getTranslate } from "@/lib/shell/translate";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A82's settings panels (RRR-127, Section 14.4, finding A65-014):
 *   Settings, Legal      announced material changes the org has not accepted yet, each with what
 *                        changes, when it takes effect and an Accept button (migration 1383); shown
 *                        to those who may accept for the org, above the acceptance history
 *   Settings, Locations and Venues   OSHA establishments with their Forms 300 and 300A and the
 *                        summary's employment figures and certification (Section 14.5, 1385)
 *   Settings, Payroll and Time Off   the WH-347 certified payroll of covered projects (1386)
 *   Me, Notifications    Subprocessor List change notices, which Owners and Admins of a customer org
 *                        receive by default (legal/subprocessors.md section 1, migration 1382); shown
 *                        only to them
 */

async function LegalChangesPanel({ ctx }: SettingsPanelProps) {
  if (!ctx.capabilities.has("org.legal.accept")) return null;
  const pending = await listPendingReacceptances(ctx.viewer.db, ctx.org.id);
  if (!pending.ok || pending.data.length === 0) return null;
  const [t, locale] = await Promise.all([getTranslations("compliance.reacceptance"), getLocale()]);
  return (
    <section aria-labelledby="legal-changes-heading" className="flex flex-col gap-12">
      <header className="flex flex-col gap-4">
        <h2 id="legal-changes-heading" className="m-0 text-heading-16 font-semibold">
          {t("settings.title")}
        </h2>
        <p className="m-0 text-text-secondary">{t("settings.lead", { org: ctx.org.name })}</p>
      </header>
      <ul className="m-0 flex list-none flex-col gap-12 p-0">
        {pending.data.map((p) => {
          const title = documentTitle(p.documentSlug);
          return (
            <li
              key={`${p.documentSlug}@${p.documentVersion}`}
              className="flex flex-col gap-8 rounded-card border border-border-subtle p-16"
            >
              <span className="text-label-14 font-medium">
                {t("settings.item", { title, version: p.documentVersion })}
              </span>
              <span className="text-text-13 text-text-secondary">
                {t(p.required ? "settings.inEffect" : "settings.takesEffect", {
                  date: legalDate(locale, p.effectiveOn),
                  noticed: legalDate(locale, p.noticedAt),
                })}
              </span>
              <p className="m-0 text-text-14">{p.summary}</p>
              <form action={acceptLegalChangeAction} className="flex flex-wrap items-center gap-12">
                <input type="hidden" name="org" value={ctx.org.slug} />
                <input type="hidden" name="document" value={p.documentSlug} />
                <input type="hidden" name="version" value={p.documentVersion} />
                <Button type="submit" variant="primary">
                  {t("settings.accept", { title, version: p.documentVersion })}
                </Button>
                <Link
                  className="text-text-13 text-accent-text underline"
                  href={`/legal/${p.documentSlug}` as Route}
                >
                  {t("settings.read", { title })}
                </Link>
              </form>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

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
  { node: "settings.legal", order: 5, Panel: LegalChangesPanel },
  {
    node: "settings.locations-and-venues",
    order: 60,
    Panel: ({ ctx }) => <OshaEstablishmentsPanel ctx={ctx} />,
  },
  {
    node: "settings.payroll-and-time-off",
    order: 60,
    Panel: ({ ctx }) => <CertifiedPayrollPanel ctx={ctx} />,
  },
  { node: "me.notifications", order: 80, Panel: SubprocessorNoticePanel },
];
