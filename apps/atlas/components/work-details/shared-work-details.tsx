import { getSharedWorkDetails } from "@xos/data/work-details";
import { formatPhone, regionFromLocale } from "@xos/i18n/formats";
import { getLocale } from "next-intl/server";
import { InlineAlert } from "@/components/ui";
import type { OrgContext } from "@/lib/shell/context";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import { revealSharedPassportAction } from "@/lib/work-details/actions";
import { WorkDetailsForm } from "./form";
import { CategoryBlock, categoryBody, workDetailLabel } from "./shared-categories";

/**
 * The engaging org's view of what the engagement's person shared (Section 4.5.6 item 10): only the
 * categories the person shared with this engagement, only while it is open, and only those the
 * viewer's project capabilities cover. The passport number stays masked; a holder of the
 * government-id capability reveals it with a reason. Each view is logged in the person's access log
 * and the org's audit ledger by app.shared_work_details.
 */

const P = "workDetails";

export async function SharedWorkDetailsSection({
  ctx,
  engagementId,
  partyName,
}: {
  ctx: OrgContext;
  engagementId: string;
  partyName: string | null;
}) {
  const [t, locale, shared] = await Promise.all([
    getTranslate(),
    getLocale(),
    getSharedWorkDetails(ctx.viewer.db, engagementId),
  ]);
  const name = partyName ?? t(`${P}.org.unnamed`);
  const wd: Translate = (key, values) => t(`${P}.${key}`, values);
  const region = regionFromLocale(locale);
  // A viewer whose project capabilities cover no category is not told whether anything was shared.
  if (!shared.ok && shared.error.kind === "not-found") return null;
  return (
    <section
      id="engagement-work-details"
      aria-labelledby="engagement-work-details-heading"
      className="flex flex-col gap-8"
    >
      <h2 id="engagement-work-details-heading" className="m-0 text-heading-14 font-semibold">
        {t(`${P}.org.title`)}
      </h2>
      {!shared.ok ? (
        <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>
      ) : !shared.data.sharingOpen ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.org.closed`)}</p>
      ) : shared.data.categories.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.org.notShared`, { name })}</p>
      ) : (
        <>
          <p className="m-0 text-text-13 text-text-secondary">
            {t(`${P}.org.description`, { name })}
          </p>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-8">
            {shared.data.categories.map((c) => (
              <CategoryBlock key={c} title={workDetailLabel(wd, "categories", c)}>
                {categoryBody(c, shared.data, wd, (e164) => formatPhone(e164, region))}
              </CategoryBlock>
            ))}
          </div>
          {shared.data.passport?.passportNumberMasked &&
          ctx.capabilities.has("data.restricted.read.government_id") ? (
            <WorkDetailsForm
              action={revealSharedPassportAction}
              hidden={{ org: ctx.org.slug, engagementId }}
              label={t(`${P}.org.reveal`)}
              submitLabel={t(`${P}.org.reveal`)}
              fields={[
                {
                  kind: "text",
                  name: "reason",
                  label: t(`${P}.org.revealReason`),
                  help: t(`${P}.org.revealReasonHelp`),
                  width: "100%",
                },
              ]}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
