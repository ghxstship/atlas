import { SearchX } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { ButtonLink } from "@/components/shell/primitives";
import { SystemMessage } from "@/components/shell/system-message";

/** 404, and every hidden page (ADR 0006): the System template, with no hint whether it exists. */
export default async function NotFound() {
  const t = await getTranslations("shell.system.notFound");
  return (
    <main id="content">
      <SystemMessage
        icon={SearchX}
        title={t("title")}
        body={t("body")}
        action={
          <ButtonLink href="/" variant="primary">
            {t("action")}
          </ButtonLink>
        }
      />
    </main>
  );
}
