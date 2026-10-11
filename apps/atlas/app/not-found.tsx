import { getTranslations } from "next-intl/server";
import { SystemPage } from "@/components/ui";

/** 404, and every hidden page (ADR 0006): the System template, with no hint whether it exists. */
export default async function NotFound() {
  const t = await getTranslations("shell.system.notFound");
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
