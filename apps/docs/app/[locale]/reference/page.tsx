import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Breadcrumbs, Link } from "@/components/ui.tsx";
import { isLocale, translator } from "@/lib/i18n.ts";
import { loadReference } from "@/lib/openapi.ts";

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  return isLocale(locale) ? { title: translator(locale)("reference.title") } : {};
}

/** Every resource, grouped by module in the document's tag order. */
export default async function ReferenceIndex({ params }: Params) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = translator(locale);
  const reference = loadReference();
  return (
    <>
      <header className="flex flex-col gap-8 pb-16 border-b border-border-subtle">
        <Breadcrumbs
          items={[{ label: t("nav.home"), href: `/${locale}` }, { label: t("reference.title") }]}
        />
        <h1 className="m-0 text-heading-24 font-semibold">{t("reference.title")}</h1>
        <p className="m-0 text-text-14 text-text-secondary">
          {t("reference.sentence", {
            count: reference.operationCount,
            resources: reference.resources.length,
            version: reference.version,
          })}{" "}
          <Link href="/openapi.json">{t("reference.openapi")}</Link>
        </p>
      </header>
      {reference.tags.map((tag) => {
        const resources = reference.resources.filter((r) => r.tag === tag.name);
        if (resources.length === 0) return null;
        return (
          <section
            key={tag.name}
            aria-labelledby={`module-${tag.name}`}
            className="flex flex-col gap-8"
          >
            <h2 id={`module-${tag.name}`} className="m-0 text-heading-16 font-semibold">
              {tag.name}
            </h2>
            <p className="m-0 text-text-13 text-text-secondary">{tag.description}</p>
            <ul className="m-0 p-0 list-none grid grid-cols-3 max-lg:grid-cols-2 max-md:grid-cols-1 gap-x-16 gap-y-8">
              {resources.map((r) => (
                <li key={r.name} className="flex items-baseline justify-between gap-8 text-text-13">
                  <Link href={`/${locale}/reference/${r.slug}`}>{r.name}</Link>
                  <span className="text-text-tertiary tabular-nums">
                    {t("reference.operations", { count: r.operations.length })}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
