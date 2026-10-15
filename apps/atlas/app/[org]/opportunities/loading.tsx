import { getTranslations } from "next-intl/server";
import { OpportunitiesSkeleton } from "@/components/opportunities/skeleton";

/** Streamed loading state for every Opportunities page (Section 11.7): a skeleton per region, never a blocking spinner. */
export default async function Loading() {
  const t = await getTranslations("opportunities");
  return <OpportunitiesSkeleton label={t("loading")} />;
}
