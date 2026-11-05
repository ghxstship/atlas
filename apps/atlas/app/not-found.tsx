import { getTranslations } from "next-intl/server";
import { TemplateSystemLink } from "@xos/ui/static";

/**
 * 404, and every hidden page (ADR 0006): the System template, with no hint whether it exists. The
 * not-found boundary is part of every route, so it renders on the server and sends no JavaScript
 * (ADR 0027).
 */
export default async function NotFound() {
  const t = await getTranslations("shell.system.notFound");
  return (
    <main id="content">
      <TemplateSystemLink
        icon="SearchX"
        title={t("title")}
        sentence={t("body")}
        actionLabel={t("action")}
        href="/"
      />
    </main>
  );
}
