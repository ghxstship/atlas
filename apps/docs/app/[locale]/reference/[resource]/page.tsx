import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MethodTag } from "@/components/operation.tsx";
import { Breadcrumbs, Link, TemplateDocument } from "@/components/ui.tsx";
import { isLocale, translator } from "@/lib/i18n.ts";
import { findResource, loadReference, operationSlug } from "@/lib/openapi.ts";

export const dynamicParams = false;

/** Every resource, prerendered for every locale. */
export function generateStaticParams(): { resource: string }[] {
  return loadReference().resources.map((r) => ({ resource: r.slug }));
}

type Params = { params: Promise<{ locale: string; resource: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { resource } = await params;
  const doc = findResource(resource);
  return doc ? { title: doc.name } : {};
}

/** One resource: its operations, each linking to the operation's own page. */
export default async function ResourcePage({ params }: Params) {
  const { locale, resource } = await params;
  const doc = findResource(resource);
  if (!doc || !isLocale(locale)) notFound();
  const t = translator(locale);
  const href = (verb: string) => `/${locale}/reference/${doc.slug}/${operationSlug({ verb })}`;
  const outline = (
    <nav
      aria-label={t("reference.outline")}
      className="sticky top-0 flex flex-col gap-4 text-text-13"
    >
      <h2 className="m-0 mb-4 text-text-12 font-semibold text-text-secondary">
        {t("reference.outline")}
      </h2>
      <ul className="m-0 p-0 list-none flex flex-col gap-8">
        {doc.operations.map((op) => (
          <li key={op.id}>
            <a
              href={href(op.verb)}
              className="text-text-secondary hover:text-text-primary no-underline"
            >
              {op.verb}
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
            { label: doc.name },
          ]}
        />
        <h1 className="m-0 text-heading-24 font-semibold font-mono">{doc.name}</h1>
        <p className="m-0 text-text-14 text-text-secondary">
          {t("reference.module", { module: doc.tag })} ·{" "}
          {t("reference.operations", { count: doc.operations.length })}
        </p>
      </header>
      {doc.operations.map((op) => (
        <section
          key={op.id}
          id={op.id}
          aria-labelledby={`${op.id}-title`}
          className="flex flex-col gap-8 pt-16 border-t border-border-subtle scroll-mt-16"
        >
          <h2 id={`${op.id}-title`} className="m-0 text-heading-16 font-semibold">
            <Link href={href(op.verb)}>{op.summary}</Link>
          </h2>
          <p className="m-0 flex flex-wrap items-center gap-8">
            <MethodTag method={op.method} />
            <code className="font-mono text-mono-13 break-all">{op.path}</code>
          </p>
          <p className="m-0 text-text-13 text-text-secondary">{op.description}</p>
        </section>
      ))}
    </TemplateDocument>
  );
}
