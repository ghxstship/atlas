"use client";

import { Button, InlineAlert, Input } from "@xos/ui";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useActionState, useEffect } from "react";
import { savePersonalSettingAction, type SettingState } from "@/lib/actions/settings";

import { keepInputOnSubmit } from "@/components/forms/keep-input";
type Translate = (key: string, values?: Record<string, string | number>) => string;

export interface PersonalSettingProps {
  readonly settingKey: string;
  readonly type: "text" | "boolean" | "integer" | "choice";
  readonly input: string;
  readonly label: string;
  readonly help: string | null;
  readonly initial: string;
  readonly sourceText: string;
  readonly setHere: boolean;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}

/** One personal setting with where its value comes from, save and reset to inherit. */
export function PersonalSetting(props: PersonalSettingProps) {
  const t = useTranslations("settings") as unknown as Translate;
  const router = useRouter();
  const [state, action, pending] = useActionState<SettingState, FormData>(
    savePersonalSettingAction,
    {},
  );
  useEffect(() => {
    if (state.saved) router.refresh();
  }, [state.saved, router]);
  const id = `setting-${props.settingKey.replaceAll(".", "-")}`;
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-8 py-12"
      aria-label={props.label}
    >
      <input type="hidden" name="key" value={props.settingKey} />
      {props.type === "boolean" ? (
        <label
          htmlFor={id}
          className="flex min-h-touch-min items-center gap-8 text-text-14 font-medium"
        >
          <input
            id={id}
            type="checkbox"
            name="value"
            defaultChecked={props.initial === "on"}
            className="size-icon-16"
          />
          {props.label}
        </label>
      ) : props.type === "choice" || props.input === "time_zone" ? (
        <label htmlFor={id} className="flex flex-col gap-4 text-text-13">
          <span className="font-medium">{props.label}</span>
          <select
            id={id}
            name="value"
            defaultValue={props.initial}
            className="min-h-touch-min rounded-control border border-border-control bg-bg-surface px-8 text-text-14 text-text-primary"
          >
            {props.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <Input
          id={id}
          name="value"
          label={props.label}
          defaultValue={props.initial}
          type={
            props.type === "integer"
              ? "number"
              : props.input === "date"
                ? "date"
                : props.input === "email"
                  ? "email"
                  : props.input === "url"
                    ? "url"
                    : "text"
          }
        />
      )}
      {props.help ? <p className="m-0 text-text-12 text-text-secondary">{props.help}</p> : null}
      <p className="m-0 text-text-12 text-text-secondary">{props.sourceText}</p>
      {state.error ? <InlineAlert tone="danger">{t(`errors.${state.error}`)}</InlineAlert> : null}
      {state.saved ? (
        <p role="status" className="m-0 text-text-12 text-success-text">
          {t("saved")}
        </p>
      ) : null}
      <div className="flex gap-8">
        <Button
          type="submit"
          size="sm"
          name="intent"
          value="save"
          disabled={pending}
          aria-busy={pending}
        >
          {t("save")}
        </Button>
        {props.setHere ? (
          <Button
            type="submit"
            size="sm"
            variant="ghost"
            name="intent"
            value="reset"
            disabled={pending}
          >
            {t("reset")}
          </Button>
        ) : null}
      </div>
    </form>
  );
}
