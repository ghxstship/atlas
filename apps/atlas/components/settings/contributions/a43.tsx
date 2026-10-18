import { listPayTransparencyRules } from "@xos/data/pay-transparency";
import { getLocale, getTranslations } from "next-intl/server";
import { InlineAlert } from "@/components/ui";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A43's settings panel (ADR 0021 item 7): Settings, Gateway and marketplace lists the pay-transparency
 * rules the platform enforces when a Contractor, Crew or Staff posting is published (Section 4.4.3,
 * 14.9; finding A38-006). The rules are platform reference data, read the same by every org; each row
 * the owner has not yet confirmed with counsel says so.
 */
async function PayTransparencyPanel({ ctx }: SettingsPanelProps) {
  const [t, locale, rules] = await Promise.all([
    getTranslations("payouts.payTransparency"),
    getLocale(),
    listPayTransparencyRules(ctx.viewer.db),
  ]);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  const pending = rules.ok ? rules.data.filter((r) => r.needsCounselReview).length : 0;
  return (
    <section aria-labelledby="pay-transparency" className="flex flex-col gap-12">
      <header className="flex flex-col gap-4">
        <h2 id="pay-transparency" className="m-0 text-heading-16 font-semibold">
          {t("title")}
        </h2>
        <p className="m-0 text-text-secondary">{t("description")}</p>
      </header>
      {!rules.ok ? (
        <InlineAlert tone="danger">{t("loadError")}</InlineAlert>
      ) : rules.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t("empty")}</p>
      ) : (
        <>
          {pending > 0 ? (
            <InlineAlert tone="warning">{t("counselPending", { count: pending })}</InlineAlert>
          ) : null}
          {/* A labelled, focusable region, so keyboard users can scroll the table sideways. */}
          <div role="region" aria-label={t("caption")} tabIndex={0} className="overflow-x-auto">
            <table className="w-full border-collapse text-text-13">
              <caption className="sr-only">{t("caption")}</caption>
              <thead>
                <tr className="text-text-12 text-text-secondary">
                  <th scope="col" className="py-6 pe-12 text-start font-medium">
                    {t("columns.jurisdiction")}
                  </th>
                  <th scope="col" className="py-6 pe-12 text-start font-medium">
                    {t("columns.effective")}
                  </th>
                  <th scope="col" className="py-6 pe-12 text-start font-medium">
                    {t("columns.remote")}
                  </th>
                  <th scope="col" className="py-6 pe-12 text-start font-medium">
                    {t("columns.citation")}
                  </th>
                  <th scope="col" className="py-6 text-start font-medium">
                    {t("columns.review")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rules.data.map((r) => (
                  <tr
                    key={`${r.jurisdictionId}-${r.effectiveFrom}`}
                    className="border-t border-border-subtle"
                  >
                    <th scope="row" className="py-6 pe-12 text-start font-mono font-medium">
                      {r.jurisdictionId}
                    </th>
                    <td className="py-6 pe-12 tabular-nums">
                      {date.format(new Date(`${r.effectiveFrom}T00:00:00Z`))}
                    </td>
                    <td className="py-6 pe-12">
                      {r.appliesToRemote ? t("remote.covered") : t("remote.onSiteOnly")}
                    </td>
                    <td className="py-6 pe-12">{r.citation}</td>
                    <td className="py-6">
                      {r.needsCounselReview ? (
                        <span className="inline-flex rounded-chip border border-border-subtle px-8 py-2 text-text-12 font-medium text-warning-text">
                          {t("needsReview")}
                        </span>
                      ) : (
                        <span className="inline-flex rounded-chip border border-border-subtle px-8 py-2 text-text-12 font-medium text-success-text">
                          {t("confirmed")}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.gateway-and-marketplace", order: 60, Panel: PayTransparencyPanel },
];
