"use client";

import { Input, Select } from "@xos/ui";
import { useActionState, useState } from "react";
import { saveCostCenterAction } from "@/app/[org]/finance/actions";
import { ActionFeedback } from "./kit-action-feedback";
import { fieldError } from "./kit-field-error";
import { useAfterSave } from "./kit-use-after-save";
import { useFinanceT } from "./kit-use-finance-t";
import { type Option } from "./kit.types";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import { INITIAL, Submit } from "./forms.shared";

// Cost centers, rates and the UPL export -----------------------------------------------------------------

export function CostCenterForm({
  org,
  scopeNodes,
  center,
}: {
  org: string;
  scopeNodes: readonly Option[];
  center?: { id: string; code: string; name: string; kind: string; scopeNodeId: string | null };
}) {
  const t = useFinanceT();
  const [state, action, pending] = useActionState(saveCostCenterAction, INITIAL);
  useAfterSave(state, center ? "edit" : "create");
  const [kind, setKind] = useState(center?.kind ?? "Standing");
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-16"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      {center ? <input type="hidden" name="id" value={center.id} /> : null}
      <Input
        id="cc-code"
        name="code"
        required
        label={t("costCenters.fields.code")}
        help={t("costCenters.fields.codeHelp")}
        defaultValue={center?.code ?? "CC-"}
        error={fieldError(t, state, "code")}
      />
      <Input
        id="cc-name"
        name="name"
        required
        width="100%"
        label={t("costCenters.fields.name")}
        defaultValue={center?.name ?? ""}
        error={fieldError(t, state, "name")}
      />
      <Select
        id="cc-kind"
        name="kind"
        label={t("costCenters.fields.kind")}
        value={kind}
        options={["Standing", "Overhead", "Event"].map((k) => ({
          value: k,
          label: t(`costCenters.kinds.${k}`),
        }))}
        onChange={(e) => setKind(e.target.value)}
      />
      {kind === "Event" ? (
        <Select
          id="cc-scope"
          name="scopeNodeId"
          label={t("costCenters.fields.scopeNode")}
          placeholder={t("costCenters.fields.chooseScope")}
          value={center?.scopeNodeId ?? ""}
          options={[...scopeNodes]}
          error={fieldError(t, state, "scopeNodeId")}
        />
      ) : null}
      <ActionFeedback state={state} />
      <Submit label={center ? t("common.save") : t("costCenters.create")} pending={pending} />
    </form>
  );
}
