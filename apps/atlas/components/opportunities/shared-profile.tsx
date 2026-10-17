import type { XosClient } from "@xos/data";
import { listCurrencies } from "@xos/data/procurement";
import { getApplicationSharedProfile, parseSharedRate } from "@xos/data/profile-sharing";
import { getFormatter, getTranslations } from "next-intl/server";
import { Muted, Section } from "@/components/opportunities/parts";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Field keys the panel names; any other key shows under its own name. */
const LABELS: Readonly<Record<string, string>> = {
  full_name: "fullName",
  email: "email",
  "company.name": "companyName",
  "profile.headline": "headline",
  "profile.bio": "bio",
  "profile.pronouns": "pronouns",
  "profile.location": "location",
  "profile.skills": "skills",
  "profile.certifications": "certifications",
  "profile.rates": "rates",
  "profile.languages": "languages",
  "profile.links": "links",
};

/**
 * Shared with you (journey 61, finding A38-003): what the applicant chose to share with this org
 * when applying, as the consent snapshot taken then. Sections the profile keeps Private elsewhere,
 * such as rates, show here because the applicant shared them with this org.
 */
export async function SharedProfile({
  db,
  applicationId,
}: {
  db: XosClient;
  applicationId: string;
}) {
  const [result, translate, format, currencies] = await Promise.all([
    getApplicationSharedProfile(db, applicationId),
    getTranslations("opportunities"),
    getFormatter(),
    listCurrencies(db),
  ]);
  const t = translate as unknown as Translate;
  // Minor units per currency come from the currency reference, never assumed.
  const exponent = (code: string) =>
    (currencies.ok ? currencies.data : []).find((c) => c.code === code)?.minorUnits ?? null;
  return (
    <Section id="application-shared" title={t("pipeline.shared.title")}>
      {!result.ok ? (
        <Muted>{t("pipeline.shared.loadFailed")}</Muted>
      ) : result.data === null ? (
        <Muted>{t("pipeline.shared.none")}</Muted>
      ) : (
        <>
          <p className="m-0 text-text-13 text-text-secondary">
            {result.data.revoked
              ? t("pipeline.shared.revoked", {
                  date: format.dateTime(new Date(result.data.sharedAt), { dateStyle: "medium" }),
                })
              : t("pipeline.shared.sharedOn", {
                  date: format.dateTime(new Date(result.data.sharedAt), { dateStyle: "medium" }),
                })}
          </p>
          <dl className="m-0 flex flex-col gap-8 text-text-13">
            {result.data.fields.map((f) => {
              const parsed = f.key === "profile.rates" ? parseSharedRate(f.value) : null;
              const digits = parsed ? exponent(parsed.currency) : null;
              const rate = parsed && digits !== null ? { ...parsed, digits } : null;
              const label = LABELS[f.key];
              return (
                <div key={f.key}>
                  <dt className="font-medium">
                    {label ? t(`pipeline.shared.fields.${label}`) : f.key}
                  </dt>
                  <dd className="m-0 whitespace-pre-wrap text-text-secondary">
                    {rate
                      ? t("pipeline.shared.rate", {
                          amount: format.number(rate.amountMinor / 10 ** rate.digits, {
                            style: "currency",
                            currency: rate.currency,
                          }),
                          unit: t(`pipeline.shared.units.${rate.unit}`),
                        })
                      : (f.value ?? t("pipeline.shared.empty"))}
                  </dd>
                </div>
              );
            })}
          </dl>
        </>
      )}
    </Section>
  );
}
