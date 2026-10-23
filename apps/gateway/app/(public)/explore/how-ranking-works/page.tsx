import { RECOMMENDATION_WEIGHTS } from "@xos/data/gateway";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ButtonLink } from "@/components/ui";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("gateway.explore.ranking");
  return { title: t("title") };
}

/** The recommendation factors in the order the page explains them. */
const FACTORS = ["skills", "certifications", "location", "availability"] as const;

/**
 * How ranking works (Section 4.4.3: "A public 'How ranking works' page lists the ranking factors. No
 * placement can be bought."). It must match app.search_marketplace (migration 1460): Recommended
 * orders by a score out of 100 built from the person's own profile (skills 40, certifications 30,
 * location 20, availability 10, RECOMMENDATION_WEIGHTS), then the deadline and the start date; Soonest
 * orders by the deadline and the start date only.
 */
export default async function RankingPage() {
  const t = await getTranslations("gateway.explore.ranking");
  return (
    <article className="flex flex-col gap-16">
      <h1 className="m-0 text-heading-24 font-semibold">{t("title")}</h1>
      <p className="m-0 text-text-16">{t("lead")}</p>
      <h2 className="m-0 text-heading-16 font-semibold">{t("recommendedTitle")}</h2>
      <p className="m-0 text-text-14">{t("recommendedLead")}</p>
      <ol className="m-0 flex flex-col gap-8 ps-24 text-text-14">
        {FACTORS.map((f) => (
          <li key={f}>
            <strong>{t(`factors.${f}.title`, { points: RECOMMENDATION_WEIGHTS[f] })}</strong>{" "}
            {t(`factors.${f}.body`)}
          </li>
        ))}
      </ol>
      <p className="m-0 text-text-14">{t("ties")}</p>
      <h2 className="m-0 text-heading-16 font-semibold">{t("soonestTitle")}</h2>
      <ol className="m-0 flex flex-col gap-8 ps-24 text-text-14">
        <li>{t("factor1")}</li>
        <li>{t("factor2")}</li>
      </ol>
      <h2 className="m-0 text-heading-16 font-semibold">{t("neverTitle")}</h2>
      <p className="m-0 text-text-14">{t("never")}</p>
      <p className="m-0 text-text-14 text-text-secondary">{t("visibility")}</p>
      <p className="m-0 text-text-14 text-text-secondary">{t("filters")}</p>
      <p className="m-0 text-text-14 text-text-secondary">{t("passed")}</p>
      <div>
        <ButtonLink href="/explore">{t("back")}</ButtonLink>
      </div>
    </article>
  );
}
