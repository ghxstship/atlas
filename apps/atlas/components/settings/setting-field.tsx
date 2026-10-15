"use client";

import { Button, Checkbox, InlineAlert, Input, Select, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useId } from "react";
import type { SettingDefinition } from "@xos/schemas/settings";
import { saveSettingAction, type SettingFormState } from "@/app/[org]/settings/registry-actions";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Catalog lookups with keys built at run time (refusal rules, choices); next-intl types only literals. */
function useCopy(namespace: string): Translate {
  const t = useTranslations(namespace as "settings");
  return (key, values) => (t as unknown as Translate)(key, values);
}

/**
 * One registered setting as a small form (Section 4.5.6): the control for its type, where the
 * current value comes from, the org lock for lockable org values, and a reset that clears the
 * value so the scope inherits again. Every label arrives translated from the server.
 */
export interface SettingFieldProps {
  readonly org: string;
  readonly group: "org" | "personal";
  readonly def: SettingDefinition;
  readonly label: string;
  readonly help: string | null;
  readonly options: readonly { readonly value: string; readonly label: string }[];
  /** The control's starting text: the value at this scope, or the inherited value. */
  readonly initial: string;
  /** Sentence naming where the value comes from, for example "Set for the organization". */
  readonly sourceText: string;
  /** True when a value is stored at this scope, so it can be reset. */
  readonly setHere: boolean;
  /** True when the stored org value is locked (org scope only). */
  readonly locked: boolean;
  /** True when a locked org value keeps this scope from overriding it. */
  readonly lockedByOrg: boolean;
  readonly canEdit: boolean;
  readonly scopeKind?: "Workspace" | "Team" | "Project";
  readonly scopeId?: string;
  /** For personal values kept for this org only. */
  readonly perOrg?: boolean;
}

const INITIAL: SettingFormState = {};

export function SettingField(props: SettingFieldProps) {
  const t = useCopy("settings");
  const [state, action, pending] = useActionState(saveSettingAction, INITIAL);
  const id = useId();
  const { def } = props;
  const disabled = !props.canEdit || props.lockedByOrg;
  const text = state.value ?? props.initial;
  const error = state.error ? t(`errors.${state.error}`) : "";
  const fieldId = `${id}-value`;

  let control;
  if (def.type === "boolean") {
    control = (
      <Checkbox
        id={fieldId}
        name="value"
        label={props.label}
        defaultChecked={text === "on"}
        disabled={disabled}
      />
    );
  } else if (def.type === "choice" || props.options.length > 0) {
    control = (
      <Select
        id={fieldId}
        name="value"
        label={props.label}
        value={text}
        {...(text === "" ? { placeholder: t("choose") } : {})}
        options={[...props.options]}
        disabled={disabled}
        error={error}
        {...(props.help ? { help: props.help } : {})}
      />
    );
  } else if (def.input === "multiline") {
    control = (
      <Textarea
        id={fieldId}
        name="value"
        label={props.label}
        defaultValue={text}
        disabled={disabled}
        maxLength={def.maxLength ?? undefined}
        width="100%"
        error={error}
        {...(props.help ? { help: props.help } : {})}
      />
    );
  } else {
    control = (
      <Input
        id={fieldId}
        name="value"
        label={props.label}
        defaultValue={text}
        disabled={disabled}
        type={
          def.type === "integer"
            ? "number"
            : def.input === "email"
              ? "email"
              : def.input === "url"
                ? "url"
                : def.input === "date"
                  ? "date"
                  : "text"
        }
        {...(def.min !== null ? { min: def.min } : {})}
        {...(def.max !== null ? { max: def.max } : {})}
        {...(def.maxLength !== null ? { maxLength: def.maxLength } : {})}
        width="100%"
        error={error}
        {...(props.help ? { help: props.help } : {})}
      />
    );
  }

  return (
    <form
      action={action}
      className="flex flex-col gap-8 py-12"
      noValidate
      aria-describedby={`${id}-source`}
    >
      <input type="hidden" name="org" value={props.org} />
      <input type="hidden" name="key" value={def.key} />
      <input type="hidden" name="group" value={props.group} />
      {props.scopeKind ? <input type="hidden" name="scopeKind" value={props.scopeKind} /> : null}
      {props.scopeId ? <input type="hidden" name="scopeId" value={props.scopeId} /> : null}
      {props.perOrg ? <input type="hidden" name="perOrg" value="on" /> : null}
      {control}
      {def.type === "boolean" && props.help ? (
        <p className="m-0 text-text-12 text-text-secondary">{props.help}</p>
      ) : null}
      {def.type === "boolean" && error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      <p id={`${id}-source`} className="m-0 text-text-12 text-text-secondary">
        {props.sourceText}
      </p>
      {def.lockable && props.group === "org" && !props.scopeKind && props.canEdit ? (
        <Checkbox
          id={`${id}-locked`}
          name="locked"
          label={t("lock")}
          defaultChecked={props.locked}
        />
      ) : null}
      {props.canEdit && !props.lockedByOrg ? (
        <div className="flex flex-wrap items-center gap-8">
          <Button type="submit" name="intent" value="save" size="sm" loading={pending}>
            {t("save")}
          </Button>
          {props.setHere ? (
            <Button type="submit" name="intent" value="clear" size="sm" variant="ghost">
              {props.group === "personal" || props.scopeKind ? t("inherit") : t("reset")}
            </Button>
          ) : null}
          {state.ok ? (
            <span role="status" className="text-text-12 text-success-text">
              {t("saved")}
            </span>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
