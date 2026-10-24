import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Breadcrumbs, Link } from "@/components/ui.tsx";
import { DICTIONARY_SCHEMAS, firstSentence, loadDictionary, tableSlug } from "@/lib/dictionary.ts";
import { isLocale, translator } from "@/lib/i18n.ts";

type Params = { params: Promise<{ locale: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { locale } = await params;
  return isLocale(locale) ? { title: translator(locale)("dictionary.title") } : {};
}

/** Every table and view, grouped by schema, generated from the database's own comments. */
export default async function DataDictionaryIndex({ params }: Params) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const t = translator(locale);
  const dictionary = loadDictionary();
  return (
    <>
      <header className="flex flex-col gap-8 pb-16 border-b border-border-subtle">
        <Breadcrumbs
          items={[{ label: t("nav.home"), href: `/${locale}` }, { label: t("dictionary.title") }]}
        />
        <h1 className="m-0 text-heading-24 font-semibold">{t("dictionary.title")}</h1>
        <p className="m-0 text-text-14 text-text-secondary">
          {t("dictionary.sentence", {
            tables: dictionary.tableCount,
            views: dictionary.viewCount,
            columns: dictionary.columnCount,
          })}
        </p>
        <p className="m-0 text-text-13 text-text-secondary">{t("dictionary.source")}</p>
      </header>
      {DICTIONARY_SCHEMAS.map((schema) => {
        const tables = dictionary.tables.filter((d) => d.schema === schema);
        if (tables.length === 0) return null;
        return (
          <section
            key={schema}
            aria-labelledby={`schema-${schema}`}
            className="flex flex-col gap-8"
          >
            <h2 id={`schema-${schema}`} className="m-0 text-heading-16 font-semibold font-mono">
              {schema}
            </h2>
            <p className="m-0 text-text-13 text-text-secondary">
              {t(`dictionary.schemas.${schema}`)}
            </p>
            <ul className="m-0 p-0 list-none flex flex-col gap-4">
              {tables.map((d) => (
                <li key={d.name} className="flex flex-wrap items-baseline gap-x-12 text-text-13">
                  <Link href={`/${locale}/data-dictionary/${tableSlug(d)}`}>
                    <span className="font-mono text-mono-13">{d.name}</span>
                  </Link>
                  <span className="text-text-secondary">{firstSentence(d.comment)}</span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}
