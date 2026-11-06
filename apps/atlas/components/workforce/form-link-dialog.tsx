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
import { dayInZone } from "@/lib/stakeholder-packs/expiry";
import { refusalText } from "@/components/projects/outside-access/refusal-text";

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
    projects: readonly { value: string; label: string; timeZone: string }[];
    orgTimeZone: string;
  } | null>(null);
  const [projectId, setProjectId] = useState("");
  // The days offered and when the last one ends follow the chosen project's zone, else the org's.
  const zone =
    options?.projects.find((p) => p.value === projectId)?.timeZone ?? options?.orgTimeZone;
  useEffect(() => {
    void formLinkOptionsAction(org).then((r) => {
      if (r.ok) setOptions(r.data);
    });
  }, [org]);
  const [state, dispatch, pending] = useActionState(
    async (_s: { error: string | null }, data: FormData) => {
      const result = await createFormLinkAction(org, {
        templateId,
        projectId: String(data.get("projectId") ?? ""),
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
          <InlineAlert tone="danger">{refusalText(errors, state.error)}</InlineAlert>
        ) : null}
        <Select
          id="form-link-project"
          name="projectId"
          label={t("project")}
          help={t("projectHelp")}
          required
          placeholder={t("chooseProject")}
          onChange={(event) => setProjectId(event.target.value)}
          options={(options?.projects ?? []).map((p) => ({ value: p.value, label: p.label }))}
        />
        <Input
          id="form-link-expires"
          name="expiresOn"
          type="date"
          label={t("expiresOn")}
          {...(zone
            ? {
                min: dayInZone(0, zone),
                max: dayInZone(89, zone),
                help: t("expiresHelp", { zone }),
              }
            : {})}
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
