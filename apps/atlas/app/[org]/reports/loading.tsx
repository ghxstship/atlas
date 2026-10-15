import { getTranslations } from "next-intl/server";
import { LoadingPanel } from "@/components/finance/panels";

/** Reports stream; this skeleton holds their place while data loads (Section 11.7). */
export default async function Loading() {
  const t = await getTranslations("finance.common");
  return <LoadingPanel label={t("loading")} />;
}
