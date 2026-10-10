import { getTranslations } from "next-intl/server";

export default async function HomePage() {
  const t = await getTranslations("shell.atlas");
  return (
    <main>
      <h1>{t("name")}</h1>
      <p>{t("tagline")}</p>
    </main>
  );
}
