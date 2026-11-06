"use client";

import {
  ENGAGEMENT_DOCUMENT_MERGE_FIELDS,
  unknownMergeFields,
} from "@xos/data/engagement-document-merge";
import type { AgreementTemplate } from "@xos/data/engagement-document-batches";
import { Button, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useState } from "react";
import { saveAgreementTemplateAction } from "@/app/[org]/opportunities/agreements-actions";
import { useKeepInput } from "@/components/collection-kit/keep-input";
import type { OpportunityActionState } from "@/lib/opportunities/action-state";

type Translate = ((key: string, values?: Record<string, string | number>) => string) & {
  has: (key: string) => boolean;
};

const INITIAL: OpportunityActionState = {};
const KINDS = ["Agreement", "Statement of Work", "Non-Disclosure Agreement"] as const;

/** An agreement template: name, kind, language, title and body, with a merge field picker and the same check the database runs. */
export function AgreementTemplateForm({
  org,
  template,
}: {
  org: string;
  template?: AgreementTemplate;
}) {
  const t = useTranslations("opportunities.agreementTemplates") as unknown as Translate;
  const errors = useTranslations("opportunities.errors") as unknown as Translate;
  const [state, formAction, pending] = useActionState(saveAgreementTemplateAction, INITIAL);
  const keep = useKeepInput(state, formAction, (done) => Boolean(done.ok));
  const [body, setBody] = useState(template?.bodyTemplate ?? "");
  const [title, setTitle] = useState(template?.titleTemplate ?? "");
  const unknown = unknownMergeFields(`${title} ${body}`);
  const insert = (field: string) => {
    if (field) setBody((prev) => `${prev}{{${field}}}`);
  };
  return (
    <form
      action={formAction}
      {...keep}
      aria-label={t("formTitle")}
      className="flex max-w-layout-form flex-col gap-12"
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="id" value={template?.id ?? ""} />
      {state.error ? (
        <InlineAlert tone="danger">{errors(state.error, { rule: state.rule ?? "" })}</InlineAlert>
      ) : null}
      {state.ok ? (
        <p role="status" className="m-0 text-text-13">
          {t("saved")}
        </p>
      ) : null}
      <Input name="name" label={t("name")} required defaultValue={template?.name ?? ""} />
      <Select
        name="kind"
        label={t("kind")}
        value={template?.kind ?? "Agreement"}
        options={KINDS.map((k) => ({ value: k, label: t(`kinds.${k.replace(/[^A-Za-z]/g, "")}`) }))}
      />
      <Select
        name="locale"
        label={t("language")}
        help={t("languageHelp")}
        value={template?.locale ?? "en-US"}
        options={[
          { value: "en-US", label: t("languages.enUS") },
          { value: "es-US", label: t("languages.esUS") },
        ]}
      />
      <Input
        name="titleTemplate"
        label={t("titleField")}
        help={t("titleHelp")}
        required
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <Select
        label={t("picker")}
        help={t("pickerHelp")}
        value=""
        options={[
          { value: "", label: t("pickerChoose") },
          ...ENGAGEMENT_DOCUMENT_MERGE_FIELDS.map((f) => ({
            value: f,
            label: t(`fieldNames.${f.replace(".", "_")}`),
          })),
        ]}
        onChange={(e) => insert(e.target.value)}
      />
      <Textarea
        id="agreement-body"
        name="bodyTemplate"
        label={t("bodyField")}
        required
        rows={12}
        width="100%"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      {unknown.length > 0 ? (
        <InlineAlert tone="warning">
          {t("unknownFields", { fields: unknown.join(", ") })}
        </InlineAlert>
      ) : null}
      <div>
        <Button
          type="submit"
          variant="secondary"
          disabled={pending || unknown.length > 0}
          aria-busy={pending}
        >
          {t("save")}
        </Button>
      </div>
    </form>
  );
}
