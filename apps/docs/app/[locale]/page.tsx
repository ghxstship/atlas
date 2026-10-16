import { notFound } from "next/navigation";
import { Card, Link } from "@/components/ui.tsx";
import { isLocale, translator } from "@/lib/i18n.ts";
import { loadReference } from "@/lib/openapi.ts";

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = translator(locale);
  const reference = loadReference();
  const cards = [
    {
      title: t("home.guidesTitle"),
      body: t("home.guidesBody"),
      href: `/${locale}/guides/getting-started`,
      action: t("home.start"),
    },
    {
      title: t("home.referenceTitle"),
      body: t("home.referenceBody"),
      href: `/${locale}/reference`,
      action: t("reference.sentence", {
        count: reference.operationCount,
        resources: reference.resources.length,
        version: reference.version,
      }),
    },
    {
      title: t("home.helpTitle"),
      body: t("home.helpBody"),
      href: `/${locale}/help`,
      action: t("nav.help"),
    },
  ];
  return (
    <>
      <header className="flex flex-col gap-8 pb-16 border-b border-border-subtle">
        <h1 className="m-0 text-heading-32 font-semibold">{t("home.title")}</h1>
        <p className="m-0 text-text-16 text-text-secondary max-w-(--layout-reading)">
          {t("home.sentence")}
        </p>
      </header>
      <ul className="m-0 p-0 list-none grid grid-cols-3 max-lg:grid-cols-1 gap-16">
        {cards.map((c) => (
          <li key={c.href}>
            <Card title={c.title}>
              <div className="flex flex-col gap-12">
                <p className="m-0 text-text-14 text-text-secondary">{c.body}</p>
                <Link href={c.href}>{c.action}</Link>
              </div>
            </Card>
          </li>
        ))}
      </ul>
      <p className="m-0">
        <Link href="/openapi.json">{t("home.openapi")}</Link>
      </p>
    </>
  );
}
