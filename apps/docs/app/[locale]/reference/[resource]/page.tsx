import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CodeBlock } from "@/components/markdown.tsx";
import { Breadcrumbs, Tag, TemplateDocument } from "@/components/ui.tsx";
import type { Translate } from "@/lib/i18n.ts";
import { isLocale, translator } from "@/lib/i18n.ts";
import type { FieldRow, OperationDoc } from "@/lib/openapi.ts";
import { findResource, loadReference } from "@/lib/openapi.ts";

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

function Fields({
  rows,
  t,
  caption,
}: {
  rows: readonly FieldRow[];
  t: Translate;
  caption: string;
}) {
  return (
    <div className="overflow-x-auto" role="region" aria-label={caption} tabIndex={0}>
      <table className="w-full border-collapse text-text-13">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {[
              t("reference.field"),
              t("reference.type"),
              t("reference.required"),
              t("reference.description"),
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
          {rows.map((r) => (
            <tr key={r.name}>
              <th
                scope="row"
                className="text-start font-mono text-mono-12 font-normal p-8 align-top border-b border-border-subtle"
              >
                {r.name}
              </th>
              <td className="p-8 align-top border-b border-border-subtle font-mono text-mono-12">
                {r.type}
              </td>
              <td className="p-8 align-top border-b border-border-subtle">
                {r.required ? t("reference.yes") : t("reference.no")}
              </td>
              <td className="p-8 align-top border-b border-border-subtle">
                {r.description}
                {r.constraints ? (
                  <span className="block text-text-12 text-text-secondary">
                    {t("reference.constraints")}: {r.constraints}
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OperationSection({ op, t }: { op: OperationDoc; t: Translate }) {
  const params = [...op.pathParams, ...op.queryParams];
  return (
    <section
      id={op.id}
      aria-labelledby={`${op.id}-title`}
      className="flex flex-col gap-12 pt-16 border-t border-border-subtle scroll-mt-16"
    >
      <h2 id={`${op.id}-title`} className="m-0 text-heading-20 font-semibold">
        {op.summary}
      </h2>
      <p className="m-0 flex flex-wrap items-center gap-8">
        <Tag tone={op.method === "GET" ? "neutral" : op.method === "DELETE" ? "danger" : "accent"}>
          {op.method}
        </Tag>
        <code className="font-mono text-mono-13 break-all">{op.path}</code>
        <code className="font-mono text-mono-12 text-text-secondary">{op.id}</code>
      </p>
      <p className="m-0 text-text-14">{op.description}</p>
      <ul className="m-0 ps-20 list-disc flex flex-col gap-4 text-text-13 text-text-secondary">
        {op.capability ? <li>{t("reference.capability", { capability: op.capability })}</li> : null}
        {op.scopes.length > 0 ? (
          <li>{t("reference.scopes", { scopes: op.scopes.join(", ") })}</li>
        ) : null}
        {op.paged ? <li>{t("reference.paged")}</li> : null}
        {op.idempotent ? <li>{t("reference.idempotent")}</li> : null}
        {op.ifMatch ? <li>{t("reference.ifMatch")}</li> : null}
        <li>{t("reference.errors", { statuses: op.errorStatuses.join(", ") })}</li>
      </ul>
      {params.length > 0 ? (
        <>
          <h3 className="m-0 text-heading-16 font-semibold">{t("reference.parameters")}</h3>
          <Fields rows={params} t={t} caption={`${op.id}: ${t("reference.parameters")}`} />
        </>
      ) : null}
      {op.body ? (
        <>
          <h3 className="m-0 text-heading-16 font-semibold">
            {t("reference.requestBody", { name: op.body.name })}
          </h3>
          <Fields rows={op.body.fields} t={t} caption={`${op.id}: ${op.body.name}`} />
          <CodeBlock
            code={JSON.stringify(op.requestExample, null, 2)}
            label={`${op.id}: ${t("reference.requestExample")}`}
          />
        </>
      ) : null}
      <h3 className="m-0 text-heading-16 font-semibold">
        {op.response
          ? t(op.paged ? "reference.responsePage" : "reference.response", {
              status: op.successStatus,
              name: op.response.name,
            })
          : t("reference.noResponseBody", { status: op.successStatus })}
      </h3>
      {op.response ? (
        <>
          <Fields rows={op.response.fields} t={t} caption={`${op.id}: ${op.response.name}`} />
          <CodeBlock
            code={JSON.stringify(op.responseExample, null, 2)}
            label={`${op.id}: ${t("reference.responseExample")}`}
          />
        </>
      ) : null}
      <h3 className="m-0 text-heading-16 font-semibold">{t("reference.samples")}</h3>
      <CodeBlock code={op.samples.curl} label={`${op.id}: curl`} />
      <CodeBlock code={op.samples.typescript} label={`${op.id}: TypeScript`} />
      <CodeBlock code={op.samples.python} label={`${op.id}: Python`} />
      <CodeBlock code={op.samples.cli} label={`${op.id}: xos`} />
    </section>
  );
}

export default async function ResourcePage({ params }: Params) {
  const { locale, resource } = await params;
  const doc = findResource(resource);
  if (!doc || !isLocale(locale)) notFound();
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
        {doc.operations.map((op) => (
          <li key={op.id}>
            <a
              href={`#${op.id}`}
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
        <OperationSection key={op.id} op={op} t={t} />
      ))}
    </TemplateDocument>
  );
}
