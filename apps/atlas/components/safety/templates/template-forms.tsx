"use client";

import type { InspectionItem, InspectionTemplate } from "@xos/data/safety-permits";
import { Checkbox, Input } from "@xos/ui";
import { saveItemAction, saveTemplateAction } from "@/app/[org]/safety/actions";
import { ActionForm, useCopy } from "@/components/places/kit/form";

/** Create or rename an inspection template. */
export function TemplateNameForm({
  org,
  template,
}: {
  org: string;
  template?: InspectionTemplate;
}) {
  const t = useCopy("permits");
  return (
    <ActionForm
      action={saveTemplateAction}
      org={org}
      hidden={template ? { id: template.id } : {}}
      submitLabel={template ? t("templates.rename") : t("templates.create")}
      successMessage={t("templates.saved")}
      onSuccess={(state) => (template ? null : { create: undefined, peek: state.id })}
    >
      {(error) => (
        <Input
          id={template ? `template-name-${template.id}` : "template-name"}
          name="name"
          required
          width="100%"
          label={t("templates.fields.name")}
          defaultValue={template?.name ?? ""}
          error={error("name")}
        />
      )}
    </ActionForm>
  );
}

/** Add an item at the end of a template, or edit one item's prompt and critical flag. */
export function ItemForm({
  org,
  templateId,
  item,
  nextPosition,
}: {
  org: string;
  templateId: string;
  item?: InspectionItem;
  nextPosition: number;
}) {
  const t = useCopy("permits");
  const idPart = item ? item.id : `new-${templateId}`;
  return (
    <ActionForm
      action={saveItemAction}
      org={org}
      hidden={item ? { id: item.id } : { templateId, position: String(nextPosition) }}
      submitLabel={item ? t("templates.saveItem") : t("templates.addItem")}
      successMessage={item ? t("templates.saved") : t("templates.itemAdded")}
      className="flex flex-wrap items-end gap-12"
    >
      {(error) => (
        <>
          <Input
            id={`item-prompt-${idPart}`}
            name="prompt"
            required
            width="100%"
            label={item ? t("templates.fields.prompt") : t("templates.fields.newPrompt")}
            defaultValue={item?.prompt ?? ""}
            error={error("prompt")}
          />
          <Checkbox
            id={`item-critical-${idPart}`}
            name="critical"
            label={t("templates.fields.critical")}
            defaultChecked={item?.critical ?? false}
          />
        </>
      )}
    </ActionForm>
  );
}
