import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Breadcrumbs, Link, Tag } from "@/components/ui.tsx";
import { findTable, loadDictionary, tableSlug } from "@/lib/dictionary.ts";
import { isLocale, translator } from "@/lib/i18n.ts";

export const dynamicParams = false;

/** Every table and view, prerendered for every locale. */
export function generateStaticParams(): { table: string }[] {
  return loadDictionary().tables.map((d) => ({ table: tableSlug(d) }));
}

type Params = { params: Promise<{ locale: string; table: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { table } = await params;
  const doc = findTable(table);
  return doc ? { title: tableSlug(doc) } : {};
}

/** One table or view: its comment, primary key and every column with type, nullability, key and comment. */
export default async function DictionaryTablePage({ params }: Params) {
  const { locale, table } = await params;
  const doc = findTable(table);
  if (!doc || !isLocale(locale)) notFound();
  const t = translator(locale);
  const kind = t(`dictionary.kinds.${doc.kind === "table" ? "table" : "view"}`);
  const caption = t("dictionary.columns", { name: tableSlug(doc) });
  const cell = "p-8 align-top border-b border-border-subtle";
  return (
    <>
      <header className="flex flex-col gap-8 pb-16 border-b border-border-subtle">
        <Breadcrumbs
          items={[
            { label: t("nav.home"), href: `/${locale}` },
            { label: t("dictionary.title"), href: `/${locale}/data-dictionary` },
            { label: tableSlug(doc) },
          ]}
        />
        <h1 className="m-0 text-heading-24 font-semibold font-mono break-all">{tableSlug(doc)}</h1>
        <p className="m-0 flex flex-wrap items-center gap-8">
          <Tag tone="neutral">{kind}</Tag>
          {doc.partitioned ? <Tag tone="neutral">{t("dictionary.partitioned")}</Tag> : null}
          {doc.kind === "table" ? (
            <Tag tone={doc.rls ? "neutral" : "danger"}>
              {doc.rls ? t("dictionary.rls") : t("dictionary.noRls")}
            </Tag>
          ) : null}
        </p>
        {doc.comment ? <p className="m-0 text-text-14">{doc.comment}</p> : null}
        {doc.primaryKey.length > 0 ? (
          <p className="m-0 text-text-13 text-text-secondary">
            {t("dictionary.primaryKey")}:{" "}
            <code className="font-mono text-mono-12">{doc.primaryKey.join(", ")}</code>
          </p>
        ) : null}
      </header>
      <div className="overflow-x-auto" role="region" aria-label={caption} tabIndex={0}>
        <table className="w-full border-collapse text-text-13">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr>
              {[
                t("dictionary.column"),
                t("dictionary.type"),
                t("dictionary.nullable"),
                t("dictionary.description"),
              ].map((h) => (
                <th
                  key={h}
                  scope="col"
                  className="text-start font-semibold p-8 border-b border-border-strong"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {doc.columns.map((c) => {
              const target = c.references?.split(".").slice(0, 2).join(".");
              return (
                <tr key={c.name}>
                  <th
                    scope="row"
                    className={`text-start font-mono text-mono-12 font-normal ${cell}`}
                  >
                    {c.name}
                  </th>
                  <td className={`font-mono text-mono-12 ${cell}`}>{c.type}</td>
                  <td className={cell}>{c.nullable ? t("dictionary.yes") : t("dictionary.no")}</td>
                  <td className={cell}>
                    {c.comment}
                    {c.references && target && findTable(target) ? (
                      <span className="block text-text-12 text-text-secondary">
                        {t("dictionary.references")}{" "}
                        <Link href={`/${locale}/data-dictionary/${target}`}>
                          <span className="font-mono text-mono-12">{c.references}</span>
                        </Link>
                      </span>
                    ) : c.references ? (
                      <span className="block text-text-12 text-text-secondary">
                        {t("dictionary.references")}{" "}
                        <code className="font-mono text-mono-12">{c.references}</code>
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
