"use client";

import { Button, Checkbox, Input, MoreFields, Select, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { SettingDefinition } from "@xos/schemas/settings";
import { saveSettingsAction, type SettingsFormState } from "@/app/[org]/settings/registry-actions";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Catalog lookups with keys built at run time (refusal rules, choices); next-intl types only literals. */
function useCopy(namespace: string): Translate {
  const t = useTranslations(namespace as "settings");
  return (key, values) => (t as unknown as Translate)(key, values);
}

/**
 * One registered setting on a settings form (Section 4.5.6): the control for its type, where the
 * current value comes from, the org lock for lockable org values, and a reset that clears the value
 * so the scope inherits again. Every label arrives translated from the server.
 */
export interface SettingFieldProps {
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
  /** For personal values kept for this org only. */
  readonly perOrg?: boolean;
}

export interface SettingsFormProps {
  readonly org: string;
  readonly group: "org" | "personal";
  /** Names the form, for example "Settings on this page". */
  readonly label: string;
  readonly fields: readonly SettingFieldProps[];
  readonly scopeKind?: "Workspace" | "Team" | "Project";
  readonly scopeId?: string;
}

/** Fields shown before More fields (Section 11.10, gate 27). */
const VISIBLE = 7;

const INITIAL: SettingsFormState = {};

/** The control's current text, as the form would submit it ("on" or "" for a checkbox). */
function currentText(form: HTMLFormElement, key: string): string | null {
  const el = form.elements.namedItem(`value:${key}`);
  if (el instanceof HTMLInputElement)
    return el.type === "checkbox" ? (el.checked ? "on" : "") : el.value;
  if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return el.value;
  return null;
}

function initialText(f: SettingFieldProps): string {
  return f.def.type === "boolean" ? (f.initial === "on" ? "on" : "") : f.initial;
}

/**
 * The registered settings of one settings section as one form with one save bar (Section 11.6,
 * A59-018). The bar appears once a value, a lock or a reset differs from what is saved, counts the
 * changes, and saves them together or discards them; until then the page carries no Save button.
 * Only the changed settings are sent, so an untouched platform default never becomes an org value.
 * A value the org locked stays read-only for lower levels, and each setting keeps its own refusal
 * message when it does not save.
 */
export function SettingsForm(props: SettingsFormProps) {
  const t = useCopy("settings");
  const [state, action, pending] = useActionState(saveSettingsAction, INITIAL);
  const formRef = useRef<HTMLFormElement>(null);
  const id = useId();
  const [dirty, setDirty] = useState<ReadonlySet<string>>(() => new Set());
  // Staged locks and resets that differ from what is saved, by setting key.
  const [locks, setLocks] = useState<Readonly<Record<string, boolean>>>({});
  const [clears, setClears] = useState<ReadonlySet<string>>(() => new Set());
  const [seen, setSeen] = useState(state.at);
  const errors = state.errors ?? {};
  const failed = Object.keys(errors);

  // A finished save clears the staged changes that saved; the ones that failed stay changed.
  if (state.at !== seen) {
    setSeen(state.at);
    setDirty(new Set(failed));
    setLocks((old) => Object.fromEntries(Object.entries(old).filter(([k]) => k in errors)));
    setClears((old) => new Set([...old].filter((k) => k in errors)));
  }
  // After a save without refusals the controls return to the saved values the server re-rendered.
  useEffect(() => {
    if (state.at !== undefined && Object.keys(state.errors ?? {}).length === 0) {
      formRef.current?.reset();
    }
  }, [state.at, state.errors]);

  const lockOf = (f: SettingFieldProps) => locks[f.def.key] ?? f.locked;

  const recompute = (nextLocks = locks, nextClears = clears) => {
    const form = formRef.current;
    if (!form) return;
    const next = new Set<string>();
    for (const f of props.fields) {
      const key = f.def.key;
      const text = currentText(form, key);
      if (nextClears.has(key)) next.add(key);
      else if (text !== null && text !== initialText(f)) next.add(key);
      else if ((nextLocks[key] ?? f.locked) !== f.locked) next.add(key);
    }
    setDirty(next);
  };

  const toggleLock = (f: SettingFieldProps) => {
    const key = f.def.key;
    const value = !lockOf(f);
    const next = Object.fromEntries(
      Object.entries({ ...locks, [key]: value }).filter(
        ([k, v]) => v !== props.fields.find((x) => x.def.key === k)?.locked,
      ),
    );
    setLocks(next);
    recompute(next, clears);
  };

  const toggleClear = (key: string) => {
    const next = new Set(clears);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setClears(next);
    recompute(locks, next);
  };

  const discard = () => {
    formRef.current?.reset();
    setLocks({});
    setClears(new Set());
    setDirty(new Set());
  };

  const inherits = props.group === "personal" || props.scopeKind !== undefined;
  const editable = props.fields.some((f) => f.canEdit && !f.lockedByOrg);

  const field = (f: SettingFieldProps): ReactNode => {
    const key = f.def.key;
    const fieldId = `${id}-${key}`;
    const cleared = clears.has(key);
    const disabled = !f.canEdit || f.lockedByOrg || cleared;
    const text = state.values?.[key] ?? f.initial;
    const error = errors[key] ? t(`errors.${errors[key]}`) : "";
    const name = `value:${key}`;
    const help = f.help ? { help: f.help } : {};
    let control: ReactNode;
    if (f.def.type === "boolean") {
      control = (
        <Checkbox
          id={fieldId}
          name={name}
          label={f.label}
          defaultChecked={text === "on"}
          disabled={disabled}
        />
      );
    } else if (f.def.type === "choice" || f.options.length > 0) {
      control = (
        <Select
          id={fieldId}
          name={name}
          label={f.label}
          value={text}
          {...(text === "" ? { placeholder: t("choose") } : {})}
          options={[...f.options]}
          disabled={disabled}
          error={error}
          {...help}
        />
      );
    } else if (f.def.input === "multiline") {
      control = (
        <Textarea
          id={fieldId}
          name={name}
          label={f.label}
          defaultValue={text}
          disabled={disabled}
          maxLength={f.def.maxLength ?? undefined}
          width="100%"
          error={error}
          {...help}
        />
      );
    } else {
      control = (
        <Input
          id={fieldId}
          name={name}
          label={f.label}
          defaultValue={text}
          disabled={disabled}
          type={
            f.def.type === "integer"
              ? "number"
              : f.def.input === "email"
                ? "email"
                : f.def.input === "url"
                  ? "url"
                  : f.def.input === "date"
                    ? "date"
                    : "text"
          }
          {...(f.def.min !== null ? { min: f.def.min } : {})}
          {...(f.def.max !== null ? { max: f.def.max } : {})}
          {...(f.def.maxLength !== null ? { maxLength: f.def.maxLength } : {})}
          width="100%"
          error={error}
          {...help}
        />
      );
    }
    const lockable = f.def.lockable && props.group === "org" && !props.scopeKind && f.canEdit;
    const resettable = f.canEdit && !f.lockedByOrg && f.setHere;
    return (
      <li key={key} className="flex flex-col gap-8 py-12">
        {control}
        {f.def.type === "boolean" && f.help ? (
          <p className="m-0 text-text-12 text-text-secondary">{f.help}</p>
        ) : null}
        {f.def.type === "boolean" && error ? (
          <p role="alert" className="m-0 text-text-12 text-danger-text">
            {error}
          </p>
        ) : null}
        <p className="m-0 text-text-12 text-text-secondary">
          {cleared ? t(inherits ? "inheritPending" : "resetPending") : f.sourceText}
        </p>
        {lockable ? (
          <>
            <input type="hidden" name={`locked:${key}`} value={lockOf(f) ? "on" : ""} />
            <div className="flex flex-wrap items-center gap-8">
              <Button
                size="sm"
                variant="ghost"
                icon="Lock"
                aria-pressed={lockOf(f)}
                aria-describedby={`${fieldId}-lock`}
                onClick={() => toggleLock(f)}
              >
                {t("lockValue")}
              </Button>
              <span id={`${fieldId}-lock`} className="text-text-12 text-text-secondary">
                {t("lock")}
              </span>
            </div>
          </>
        ) : null}
        {resettable ? (
          <div>
            <Button size="sm" variant="ghost" onClick={() => toggleClear(key)}>
              {cleared ? t("undoReset") : inherits ? t("inherit") : t("reset")}
            </Button>
          </div>
        ) : null}
        {f.perOrg ? <input type="hidden" name="perOrg" value={key} /> : null}
      </li>
    );
  };

  const shown = props.fields.slice(0, VISIBLE);
  const more = props.fields.slice(VISIBLE);
  const savedNow = (state.saved?.length ?? 0) > 0 && failed.length === 0 && dirty.size === 0;

  return (
    <form
      ref={formRef}
      action={action}
      aria-label={props.label}
      noValidate
      onInput={() => recompute()}
      onChange={() => recompute()}
      className="flex flex-col"
    >
      <input type="hidden" name="org" value={props.org} />
      <input type="hidden" name="group" value={props.group} />
      {props.scopeKind ? <input type="hidden" name="scopeKind" value={props.scopeKind} /> : null}
      {props.scopeId ? <input type="hidden" name="scopeId" value={props.scopeId} /> : null}
      {[...dirty].map((key) => (
        <input key={`dirty-${key}`} type="hidden" name="dirty" value={key} />
      ))}
      {[...clears].map((key) => (
        <input key={`clear-${key}`} type="hidden" name="clear" value={key} />
      ))}
      <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
        {shown.map(field)}
      </ul>
      {more.length > 0 ? (
        <MoreFields open={more.some((f) => f.def.key in errors)}>
          <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
            {more.map(field)}
          </ul>
        </MoreFields>
      ) : null}
      {editable && dirty.size > 0 ? (
        <div className="sticky bottom-0 z-sticky flex flex-wrap items-center justify-end gap-8 border-t border-border-subtle bg-bg-canvas py-12">
          <span role="status" className="me-auto text-text-12 text-text-secondary">
            {t("unsaved", { count: dirty.size })}
          </span>
          <Button variant="ghost" onClick={discard}>
            {t("discard")}
          </Button>
          <Button type="submit" variant="primary" loading={pending}>
            {t("save")}
          </Button>
        </div>
      ) : savedNow ? (
        <p role="status" className="m-0 py-12 text-text-12 text-success-text">
          {t("saved")}
        </p>
      ) : null}
    </form>
  );
}
