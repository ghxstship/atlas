"use client";

import { Button, Checkbox, Dialog, InlineAlert, Input, Select } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useState } from "react";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import {
  createFormLinkAction,
  formLinkOptionsAction,
  type Revealed,
} from "@/lib/outside-access/actions";

type Translate = ((key: string, values?: Record<string, string | number>) => string) & {
  has?: (key: string) => boolean;
};

/** The public form link's options (B2, ADR 0141): project, expiry, cap in any 24 hours, one per email. */
export function FormLinkDialog({
  org,
  templateId,
  onCreated,
  onClose,
}: {
  org: string;
  templateId: string;
  onCreated: (revealed: Revealed) => void;
  onClose: () => void;
}) {
  const t = useTranslations("workforce.forms.publicLink") as unknown as Translate;
  const errors = useTranslations("projects.outsideAccess.errors") as unknown as Translate;
  const [options, setOptions] = useState<{
    projects: readonly { value: string; label: string }[];
    today: string;
    lastDay: string;
  } | null>(null);
  useEffect(() => {
    void formLinkOptionsAction(org).then((r) => {
      if (r.ok) setOptions(r.data);
    });
  }, [org]);
  const [state, dispatch, pending] = useActionState(
    async (_s: { error: string | null }, data: FormData) => {
      const project = String(data.get("projectId") ?? "");
      const result = await createFormLinkAction(org, {
        templateId,
        projectId: project === "" ? null : project,
        expiresOn: String(data.get("expiresOn") ?? ""),
        dailyCap: Number(data.get("dailyCap") ?? 200),
        onePerEmail: data.get("onePerEmail") === "on",
      });
      if (!result.ok) return { error: result.error };
      onCreated(result.data);
      return { error: null };
    },
    { error: null },
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title")}
      description={t("description")}
      actions={
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("close")}
        </Button>
      }
    >
      <form
        action={dispatch}
        onSubmit={keepInputOnSubmit(dispatch)}
        className="flex flex-col gap-8"
      >
        {state.error ? (
          <InlineAlert tone="danger">
            {errors.has?.(state.error) === false ? errors("unexpected") : errors(state.error)}
          </InlineAlert>
        ) : null}
        <Select
          id="form-link-project"
          name="projectId"
          label={t("project")}
          help={t("projectHelp")}
          value=""
          options={[{ value: "", label: t("noProject") }, ...(options?.projects ?? [])]}
        />
        <Input
          id="form-link-expires"
          name="expiresOn"
          type="date"
          label={t("expiresOn")}
          min={options?.today}
          max={options?.lastDay}
          required
        />
        <Input
          id="form-link-cap"
          name="dailyCap"
          type="number"
          min={1}
          max={1000}
          defaultValue={200}
          label={t("dailyCap")}
        />
        <Checkbox id="form-link-one" name="onePerEmail" defaultChecked label={t("onePerEmail")} />
        <div>
          <Button type="submit" variant="primary" loading={pending}>
            {t("submit")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
