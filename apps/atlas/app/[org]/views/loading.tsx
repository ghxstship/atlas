import { getTranslations } from "next-intl/server";
import { LoadingPanel } from "@/components/platform/kit";

export default async function Loading() {
  const t = await getTranslations("savedViews");
  return <LoadingPanel label={t("loading")} />;
}
