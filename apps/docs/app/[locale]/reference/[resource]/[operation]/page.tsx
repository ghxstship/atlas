import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OperationBody } from "@/components/operation.tsx";
import { Breadcrumbs, TemplateDocument } from "@/components/ui.tsx";
import { isLocale, translator } from "@/lib/i18n.ts";
import { findOperation, operationPages, operationSlug } from "@/lib/openapi.ts";

export const dynamicParams = false;

/** Every operation in the OpenAPI document has its own page, prerendered for every locale. */
export function generateStaticParams(): { resource: string; operation: string }[] {
  return operationPages();
}

type Params = { params: Promise<{ locale: string; resource: string; operation: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { resource, operation } = await params;
  const found = findOperation(resource, operation);
  return found
    ? {
        title: `${found.operation.summary} (${found.operation.id})`,
        description: found.operation.description,
      }
    : {};
}

export default async function OperationPage({ params }: Params) {
  const { locale, resource, operation } = await params;
  const found = findOperation(resource, operation);
  if (!found || !isLocale(locale)) notFound();
  const { resource: doc, operation: op } = found;
  const t = translator(locale);
  const outline = (
    <nav
      aria-label={t("reference.outline")}
      className="sticky top-0 flex flex-col gap-4 text-text-13"
    >
      <h2 className="m-0 mb-4 text-text-12 font-semibold text-text-secondary">
        {t("reference.outline")}
      </h2>
      <ul className="m-0 p-0 list-none flex flex-col gap-8">
        {doc.operations.map((other) => (
          <li key={other.id}>
            <a
              href={`/${locale}/reference/${doc.slug}/${operationSlug(other)}`}
              aria-current={other.id === op.id ? "page" : undefined}
              className={
                other.id === op.id
                  ? "text-text-primary font-semibold no-underline"
                  : "text-text-secondary hover:text-text-primary no-underline"
              }
            >
              {other.verb}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
  return (
    <TemplateDocument outline={outline}>
      <header className="flex flex-col gap-8">
        <Breadcrumbs
          items={[
            { label: t("nav.home"), href: `/${locale}` },
            { label: t("reference.title"), href: `/${locale}/reference` },
            { label: doc.name, href: `/${locale}/reference/${doc.slug}` },
            { label: op.verb },
          ]}
        />
        <h1 className="m-0 text-heading-24 font-semibold">{op.summary}</h1>
        <p className="m-0 text-text-14 text-text-secondary">
          {t("reference.module", { module: doc.tag })}
        </p>
      </header>
      <OperationBody op={op} t={t} />
    </TemplateDocument>
  );
}
