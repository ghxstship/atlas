"use client";

import { Button, Dialog, Input, Select } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import type { Condition } from "@/lib/views/conditions";
import {
  choiceLabelKey,
  choiceOf,
  choicesFor,
  needsValue,
  toCondition,
  type FilterChoice,
  type FilterTarget,
} from "./filter-model";

/** Copy lookups take built keys (`filter.ops.is`), so the catalog type is widened. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * The condition editor of the Add filter control (filter-bar.tsx), loaded when first opened: a field, how to
 * compare it and a value in the control the field's kind takes (a list for choices, people, yes or no and a
 * column's few values, a date, a number or text).
 */
export function FilterEditor({
  targets,
  condition,
  onClose,
  onApply,
}: {
  targets: readonly FilterTarget[];
  /** The condition edited; null when adding one. */
  condition: Condition | null;
  onClose: () => void;
  onApply: (condition: Condition) => void;
}) {
  const t = useTranslations("views") as unknown as Translate;
  const formId = useId();
  const initial =
    (condition && targets.find((x) => x.scope === condition.scope && x.key === condition.key)) ??
    targets[0];
  const [target, setTarget] = useState<FilterTarget | undefined>(initial);
  const [choice, setChoice] = useState<FilterChoice | undefined>(
    condition && initial ? choiceOf(condition) : initial ? choicesFor(initial)[0] : undefined,
  );
  const [value, setValue] = useState(
    condition && condition.operator !== "is_null" ? condition.value : "",
  );
  const [missing, setMissing] = useState(false);
  if (!target || !choice) return null;
  const targetId = (x: FilterTarget) => `${x.scope}:${x.key}`;

  const pick = (id: string) => {
    const next = targets.find((x) => targetId(x) === id);
    if (!next) return;
    setTarget(next);
    setChoice(choicesFor(next)[0]);
    setValue("");
    setMissing(false);
  };

  const apply = () => {
    if (needsValue(choice) && value.trim() === "") {
      setMissing(true);
      return;
    }
    onApply(toCondition(target, choice, value));
  };

  const valueControl = () => {
    if (!needsValue(choice)) return null;
    const error = missing ? t("filter.valueRequired") : "";
    const common = { id: `${formId}-value`, label: t("filter.value"), error };
    if (target.options && target.options.length > 0) {
      return (
        <Select
          key={targetId(target)}
          {...common}
          value={value}
          placeholder={t("filter.choose")}
          options={target.options.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(e) => setValue(e.target.value)}
        />
      );
    }
    const dated = target.kind === "date" || target.kind === "timestamp";
    const numeric = target.kind === "number" || target.kind === "money";
    return (
      <Input
        key={targetId(target)}
        {...common}
        type={dated ? "date" : "text"}
        width="100%"
        value={value}
        {...(numeric ? { inputMode: "decimal" as const } : {})}
        {...(target.kind === "money" ? { help: t("filter.moneyHelp") } : {})}
        {...(target.kind === "timestamp" ? { help: t("filter.dayHelp") } : {})}
        onChange={(e) => setValue(e.target.value)}
      />
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={condition ? t("filter.editTitle") : t("filter.addTitle")}
      description={t("filter.description")}
      actions={
        <>
          <Button onClick={onClose}>{t("filter.cancel")}</Button>
          <Button variant="primary" type="submit" form={formId}>
            {t("filter.apply")}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-12"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        <Select
          id={`${formId}-field`}
          label={t("filter.field")}
          value={targetId(target)}
          options={targets.map((x) => ({ value: targetId(x), label: x.label }))}
          onChange={(e) => pick(e.target.value)}
        />
        <Select
          key={`${targetId(target)}-choice`}
          id={`${formId}-choice`}
          label={t("filter.condition")}
          value={choice}
          options={choicesFor(target).map((c) => ({
            value: c,
            label: t(`filter.ops.${choiceLabelKey(target.kind, c)}`),
          }))}
          onChange={(e) => {
            setChoice(e.target.value as FilterChoice);
            setMissing(false);
          }}
        />
        {valueControl()}
      </form>
    </Dialog>
  );
}
