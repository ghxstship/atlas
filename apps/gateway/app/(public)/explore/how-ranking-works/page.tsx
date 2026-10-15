import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { ButtonLink } from "@/components/ui";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("gateway.explore.ranking");
  return { title: t("title") };
}

/**
 * How ranking works (Section 4.4.3): the public list of ranking factors. It must match
 * searchOpportunities in @xos/data, which orders by deadline, then start date, and nothing else.
 */
export default async function RankingPage() {
  const t = await getTranslations("gateway.explore.ranking");
  return (
    <article className="flex flex-col gap-16">
      <h1 className="m-0 text-heading-24 font-semibold">{t("title")}</h1>
      <p className="m-0 text-text-16">{t("lead")}</p>
      <ol className="m-0 flex flex-col gap-8 ps-24 text-text-14">
        <li>{t("factor1")}</li>
        <li>{t("factor2")}</li>
      </ol>
      <p className="m-0 text-text-14 text-text-secondary">{t("visibility")}</p>
      <p className="m-0 text-text-14 text-text-secondary">{t("filters")}</p>
      <div>
        <ButtonLink href="/explore">{t("back")}</ButtonLink>
      </div>
    </article>
  );
}
