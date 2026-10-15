import { getTranslations } from "next-intl/server";
import { SystemPage } from "@/components/ui";

/** 404, and every hidden page (ADR 0017 item 3): the System template, with no hint whether it exists. */
export default async function NotFound() {
  const t = await getTranslations("gateway.system.notFound");
  return (
    <main id="content">
      <SystemPage
        icon="SearchX"
        title={t("title")}
        sentence={t("body")}
        actionLabel={t("action")}
        href="/"
      />
    </main>
  );
}
