"use client";

import type { AgreementTemplate, BatchPerson } from "@xos/data/engagement-document-batches";
import { Button, InlineAlert, MultiSelect, Select, Tag } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import {
  createAgreementBatchAction,
  previewAgreementBatchAction,
  sendGeneratedBatchAction,
  type PreviewState,
} from "@/app/[org]/opportunities/agreements-actions";
import { useKeepInput } from "@/components/collection-kit/keep-input";

type Translate = ((key: string, values?: Record<string, string | number>) => string) & {
  has: (key: string) => boolean;
};

const INITIAL: PreviewState = {};

/**
 * Generate agreements on a project: a template, an optional Electronic Signature requirement and the people, previewed per
 * person with missing fields flagged. Only people with every field are created. Then Send. A company engagement never
 * appears here: that person signs through the vendor.
 */
export function GenerateAgreements({
  org,
  projectId,
  templates,
  requirements,
  people,
  canReadRates,
}: {
  org: string;
  projectId: string;
  templates: readonly Pick<AgreementTemplate, "id" | "name" | "usesRate">[];
  requirements: readonly { id: string; name: string }[];
  people: readonly BatchPerson[];
  canReadRates: boolean;
}) {
  const t = useTranslations("opportunities.agreementBatches") as unknown as Translate;
  const fieldNames = useTranslations(
    "opportunities.agreementTemplates.fieldNames",
  ) as unknown as Translate;
  const refusals = useTranslations("opportunities.errors.refusal") as unknown as Translate;
  const [preview, previewAction, previewing] = useActionState(previewAgreementBatchAction, INITIAL);
  const [created, createAction, creating] = useActionState(createAgreementBatchAction, INITIAL);
  const [sent, sendAction, sending] = useActionState(sendGeneratedBatchAction, INITIAL);
  const keep = useKeepInput(preview, previewAction, () => false);
  const [template, setTemplate] = useState(templates[0]?.id ?? "");
  const [requirement, setRequirement] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const chosen = templates.find((x) => x.id === template);
  const rateBlocked = chosen?.usesRate === true && !canReadRates;
  const rows = created.rows ?? preview.rows ?? [];
  const problem = created.error ?? preview.error;
  const rule = created.rule ?? preview.rule;
  const names = picked.join(",");
  return (
    <div className="flex flex-col gap-12">
      <form
        action={previewAction}
        {...keep}
        aria-label={t("generateTitle")}
        className="flex max-w-layout-form flex-col gap-12"
      >
        <input type="hidden" name="org" value={org} />
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="engagementIds" value={names} />
        <Select
          name="templateId"
          label={t("template")}
          value={template}
          options={templates.map((x) => ({ value: x.id, label: x.name }))}
          onChange={(e) => setTemplate(e.target.value)}
        />
        <Select
          name="requirementId"
          label={t("requirement")}
          help={t("requirementHelp")}
          value={requirement}
          options={[
            { value: "", label: t("noRequirement") },
            ...requirements.map((r) => ({ value: r.id, label: r.name })),
          ]}
          onChange={(e) => setRequirement(e.target.value)}
        />
        <MultiSelect
          label={t("people")}
          help={t("peopleHelp")}
          value={picked}
          options={people.map((p) => ({
            value: p.engagementId,
            label: p.jobTitle ? `${p.name} · ${p.jobTitle}` : p.name,
          }))}
          onChange={setPicked}
        />
        {rateBlocked ? (
          <InlineAlert tone="warning">{refusals("document_merge_rate_restricted")}</InlineAlert>
        ) : null}
        {problem ? (
          <InlineAlert tone="danger">
            {problem === "refusal"
              ? refusals.has(rule ?? "")
                ? refusals(rule ?? "")
                : refusals("generic", { rule: rule ?? "" })
              : t(`errors.${problem}`)}
          </InlineAlert>
        ) : null}
        <div>
          <Button
            type="submit"
            variant="secondary"
            disabled={previewing || picked.length === 0 || rateBlocked}
            aria-busy={previewing}
          >
            {t("preview")}
          </Button>
        </div>
      </form>
      {rows.length > 0 ? (
        <section aria-labelledby="agreement-preview" className="flex flex-col gap-8">
          <h3 id="agreement-preview" className="m-0 text-text-14 font-semibold">
            {t("previewTitle", { count: rows.length })}
          </h3>
          <ul className="m-0 flex list-none flex-col gap-8 p-0">
            {rows.map((r) => {
              const result = created.created?.find((c) => c.engagementId === r.engagementId);
              return (
                <li
                  key={r.engagementId}
                  className="flex flex-col gap-4 rounded-card border border-border-subtle p-12 text-text-13"
                >
                  <div className="flex flex-wrap items-center justify-between gap-8">
                    <span className="font-medium">{r.name}</span>
                    {r.missing.length > 0 ? (
                      <Tag tone="warning">{t("missingTag")}</Tag>
                    ) : result ? (
                      <Tag tone={result.outcome === "created" ? "success" : "danger"}>
                        {result.outcome === "created" ? t("createdTag") : t("refusedTag")}
                      </Tag>
                    ) : (
                      <Tag tone="neutral">{t("readyTag")}</Tag>
                    )}
                  </div>
                  {r.missing.length > 0 ? (
                    <p className="m-0 text-text-12 text-text-secondary">
                      {t("missing", {
                        fields: r.missing
                          .map((f) =>
                            fieldNames.has(f.replace(".", "_"))
                              ? fieldNames(f.replace(".", "_"))
                              : f,
                          )
                          .join(", "),
                      })}
                    </p>
                  ) : null}
                  {result?.outcome === "refused" ? (
                    <p className="m-0 text-text-12 text-text-secondary">
                      {refusals.has(result.code ?? "")
                        ? refusals(result.code ?? "")
                        : refusals("generic", { rule: result.code ?? "" })}
                    </p>
                  ) : null}
                  <p className="m-0 text-text-13 font-medium">{r.title}</p>
                  <p className="m-0 whitespace-pre-wrap text-text-12 text-text-secondary">
                    {r.body}
                  </p>
                </li>
              );
            })}
          </ul>
          {!created.batchId ? (
            <form action={createAction}>
              <input type="hidden" name="org" value={org} />
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="templateId" value={template} />
              <input type="hidden" name="engagementIds" value={names} />
              <input type="hidden" name="requirementId" value={requirement} />
              <Button
                type="submit"
                variant="secondary"
                disabled={creating || rows.every((r) => r.missing.length > 0)}
                aria-busy={creating}
              >
                {t("create", { count: rows.filter((r) => r.missing.length === 0).length })}
              </Button>
            </form>
          ) : (
            <form action={sendAction}>
              <input type="hidden" name="org" value={org} />
              <input type="hidden" name="batchId" value={created.batchId} />
              <Button
                type="submit"
                variant="secondary"
                disabled={sending || sent.sent !== undefined}
                aria-busy={sending}
              >
                {t("send")}
              </Button>
              {sent.sent !== undefined ? (
                <p role="status" className="m-0 mt-8 text-text-13">
                  {t("sentDone", { count: sent.sent })}
                </p>
              ) : null}
            </form>
          )}
        </section>
      ) : null}
    </div>
  );
}
