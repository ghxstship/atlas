/**
 * One API operation, rendered from the OpenAPI document: method and path, description,
 * requirements, parameters, request body, response and code samples. Server component.
 */
import type { ReactElement } from "react";
import { CodeBlock } from "@/components/markdown.tsx";
import { Tag } from "@/components/ui.tsx";
import type { Translate } from "@/lib/i18n.ts";
import type { FieldRow, OperationDoc } from "@/lib/openapi.ts";

export function MethodTag({ method }: { method: string }): ReactElement {
  return (
    <Tag tone={method === "GET" ? "neutral" : method === "DELETE" ? "danger" : "accent"}>
      {method}
    </Tag>
  );
}

function Fields({
  rows,
  t,
  caption,
}: {
  rows: readonly FieldRow[];
  t: Translate;
  caption: string;
}): ReactElement {
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

/** The body of an operation page, below its h1. Subsections are h2. */
export function OperationBody({ op, t }: { op: OperationDoc; t: Translate }): ReactElement {
  const params = [...op.pathParams, ...op.queryParams];
  const heading = "m-0 pt-16 border-t border-border-subtle text-heading-16 font-semibold";
  return (
    <>
      <p className="m-0 flex flex-wrap items-center gap-8">
        <MethodTag method={op.method} />
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
          <h2 className={heading}>{t("reference.parameters")}</h2>
          <Fields rows={params} t={t} caption={`${op.id}: ${t("reference.parameters")}`} />
        </>
      ) : null}
      {op.body ? (
        <>
          <h2 className={heading}>{t("reference.requestBody", { name: op.body.name })}</h2>
          <Fields rows={op.body.fields} t={t} caption={`${op.id}: ${op.body.name}`} />
          <CodeBlock
            code={JSON.stringify(op.requestExample, null, 2)}
            label={`${op.id}: ${t("reference.requestExample")}`}
          />
        </>
      ) : null}
      <h2 className={heading}>
        {op.response
          ? t(op.paged ? "reference.responsePage" : "reference.response", {
              status: op.successStatus,
              name: op.response.name,
            })
          : t("reference.noResponseBody", { status: op.successStatus })}
      </h2>
      {op.response ? (
        <>
          <Fields rows={op.response.fields} t={t} caption={`${op.id}: ${op.response.name}`} />
          <CodeBlock
            code={JSON.stringify(op.responseExample, null, 2)}
            label={`${op.id}: ${t("reference.responseExample")}`}
          />
        </>
      ) : null}
      <h2 className={heading}>{t("reference.samples")}</h2>
      <CodeBlock code={op.samples.curl} label={`${op.id}: curl`} />
      <CodeBlock code={op.samples.typescript} label={`${op.id}: TypeScript`} />
      <CodeBlock code={op.samples.python} label={`${op.id}: Python`} />
      <CodeBlock code={op.samples.cli} label={`${op.id}: xos`} />
    </>
  );
}
