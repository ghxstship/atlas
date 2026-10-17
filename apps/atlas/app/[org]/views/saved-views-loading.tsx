import { getTranslations } from "next-intl/server";
import { LoadingPanel } from "@/components/platform/kit";

/** The list's loading state. It is a Suspense fallback inside the page, not a loading.tsx, so the
 * `[viewId]` route below keeps answering 404 for an unknown view instead of a streamed 200. */
export async function SavedViewsLoading() {
  const t = await getTranslations("savedViews");
  return <LoadingPanel label={t("loading")} />;
}
