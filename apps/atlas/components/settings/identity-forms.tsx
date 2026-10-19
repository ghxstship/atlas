"use client";

import { Button, Checkbox, InlineAlert, Input, Select } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useState, type CSSProperties } from "react";
import { checkAccentAction } from "@/app/[org]/settings/actions";
import {
  acceptLegalAction,
  addDomainAction,
  removeDomainAction,
  saveBrandAction,
  saveModulesAction,
  uploadBrandAssetAction,
  type IdentityFormState,
} from "@/app/[org]/settings/identity-actions";
import type { AccentCheck } from "@/lib/brand/contrast";

import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Catalog lookups with keys built at run time (refusal rules, choices); next-intl types only literals. */
function useCopy(namespace: string): Translate {
  const t = useTranslations(namespace as "settings");
  return (key, values) => (t as unknown as Translate)(key, values);
}

/** Client forms for the A30 settings panels; each keeps what the person typed after a refusal. */

const INITIAL: IdentityFormState = {};

function FormStatus({ state }: { state: IdentityFormState }) {
  const t = useCopy("settings");
  if (state.error) return <InlineAlert tone="danger">{t(`errors.${state.error}`)}</InlineAlert>;
  if (state.ok) {
    return (
      <p role="status" className="m-0 text-text-13 text-success-text">
        {t("saved")}
      </p>
    );
  }
  return null;
}

// Brand -------------------------------------------------------------------------------------------

export interface BrandFormProps {
  readonly org: string;
  readonly canEdit: boolean;
  readonly whiteLabelInPlan: boolean;
  readonly fonts: readonly string[];
  readonly brand: {
    readonly displayName: string;
    readonly accentHex: string;
    readonly neutralTintHex: string;
    readonly fontFamily: string;
    readonly radiusScale: string;
    readonly emailSenderName: string;
    readonly supportEmail: string;
    readonly legalEntityName: string;
    readonly suppressPoweredBy: boolean;
  };
  readonly defaultAccent: string;
}

export function BrandForm(props: BrandFormProps) {
  const t = useCopy("settings.brand");
  const tErr = useCopy("settings.errors");
  const [state, action, pending] = useActionState(saveBrandAction, INITIAL);
  const [accent, setAccent] = useState(props.brand.accentHex || props.defaultAccent);
  const [check, setCheck] = useState<AccentCheck | null>(null);
  const valid = /^#[0-9a-fA-F]{6}$/.test(accent);

  useEffect(() => {
    if (!valid) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const result = await checkAccentAction(accent);
      if (!cancelled) setCheck(result);
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [accent, valid]);

  const current = valid ? check : null;
  const fieldError = (name: string) =>
    state.fieldErrors?.[name] ? tErr(state.fieldErrors[name] ?? "invalid") : "";
  const disabled = !props.canEdit;

  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex max-w-layout-form flex-col gap-16"
      noValidate
    >
      <input type="hidden" name="org" value={props.org} />
      <FormStatus state={state} />
      <Input
        id="brand-display-name"
        name="displayName"
        label={t("displayName")}
        help={t("displayNameHelp")}
        defaultValue={props.brand.displayName}
        disabled={disabled}
        width="100%"
        error={fieldError("displayName")}
      />
      <div className="flex flex-wrap items-end gap-12">
        <Input
          id="brand-accent"
          name="accentHex"
          spellCheck={false}
          label={t("accent")}
          help={t("accentHelp")}
          value={accent}
          disabled={disabled}
          onChange={(e) => setAccent(e.target.value.trim())}
          error={valid ? fieldError("accentHex") : t("invalidColor")}
        />
        <input
          type="color"
          aria-label={t("accent")}
          value={valid ? accent : props.defaultAccent}
          disabled={disabled}
          onChange={(e) => setAccent(e.target.value.toUpperCase())}
          className="h-control-md w-48 cursor-pointer rounded-control border border-border-control bg-bg-surface"
        />
      </div>
      {current ? (
        current.passes ? (
          <InlineAlert tone="success">{t("passes")}</InlineAlert>
        ) : (
          <InlineAlert tone="danger" title={t("fails", { count: current.failures.length })}>
            <ul className="m-0 ps-16">
              {current.failures.map((f) => (
                <li key={`${f.theme}-${f.rule}-${f.fg}-${f.bg}`}>
                  {t("failure", {
                    rule: f.rule,
                    theme: f.theme,
                    ratio: f.ratio.toFixed(2),
                    min: f.min,
                  })}
                </li>
              ))}
            </ul>
          </InlineAlert>
        )
      ) : null}
      <div
        className="flex gap-12 rounded-card border border-border-subtle p-16"
        aria-label={t("preview")}
        role="group"
        // A visual sample of the brand color, not a control.
        inert
        style={
          current?.passes ? ({ "--color-accent-default": accent } as CSSProperties) : undefined
        }
      >
        <Button variant="primary" type="button">
          {t("previewAction")}
        </Button>
      </div>
      <Input
        id="brand-tint"
        name="neutralTintHex"
        spellCheck={false}
        label={t("neutralTint")}
        help={t("neutralTintHelp")}
        defaultValue={props.brand.neutralTintHex}
        disabled={disabled}
        error={fieldError("neutralTintHex")}
      />
      <div className="flex flex-wrap gap-12">
        <Select
          id="brand-font"
          name="fontFamily"
          label={t("font")}
          value={props.brand.fontFamily}
          disabled={disabled}
          options={[
            { value: "", label: t("fontDefault") },
            ...props.fonts.map((f) => ({ value: f, label: f })),
          ]}
        />
        <Select
          id="brand-radius"
          name="radiusScale"
          label={t("radius")}
          value={props.brand.radiusScale}
          disabled={disabled}
          options={(["Compact", "Default", "Rounded"] as const).map((r) => ({
            value: r,
            label: t(`radius${r}`),
          }))}
        />
      </div>
      <Input
        id="brand-sender"
        name="emailSenderName"
        label={t("senderName")}
        help={t("senderNameHelp")}
        defaultValue={props.brand.emailSenderName}
        disabled={disabled}
        width="100%"
        error={fieldError("emailSenderName")}
      />
      <Input
        id="brand-support-email"
        name="supportEmail"
        type="email"
        label={t("supportEmail")}
        defaultValue={props.brand.supportEmail}
        disabled={disabled}
        width="100%"
        error={fieldError("supportEmail")}
      />
      <Input
        id="brand-legal-entity"
        name="legalEntityName"
        label={t("legalEntity")}
        help={t("legalEntityHelp")}
        defaultValue={props.brand.legalEntityName}
        disabled={disabled}
        width="100%"
        error={fieldError("legalEntityName")}
      />
      <div className="flex flex-col gap-4">
        <Checkbox
          id="brand-powered-by"
          name="suppressPoweredBy"
          label={t("suppressPoweredBy")}
          defaultChecked={props.brand.suppressPoweredBy}
          disabled={disabled || !props.whiteLabelInPlan}
        />
        <p className="m-0 text-text-12 text-text-secondary">
          {props.whiteLabelInPlan ? t("suppressHelp") : t("suppressNeedsPlan")}
        </p>
      </div>
      {props.canEdit ? (
        <div>
          <Button
            type="submit"
            variant="primary"
            loading={pending}
            disabled={valid && current?.passes === false}
          >
            {t("save")}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

export function BrandAssetForm({
  org,
  slot,
  label,
  current,
}: {
  org: string;
  slot: "logoLight" | "logoDark" | "favicon" | "appIcon";
  label: string;
  current: string | null;
}) {
  const t = useCopy("settings.brand");
  const tErr = useCopy("settings.errors");
  const [state, action, pending] = useActionState(uploadBrandAssetAction, INITIAL);
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
    >
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="slot" value={slot} />
      <label htmlFor={`asset-${slot}`} className="text-label-13 font-medium">
        {label}
      </label>
      <p className="m-0 text-text-12 text-text-secondary">
        {current
          ? t("assetCurrent", { name: current.split("/").pop() ?? current })
          : t("assetNone")}
      </p>
      <input
        id={`asset-${slot}`}
        name="file"
        type="file"
        accept="image/png,image/webp,image/x-icon"
        aria-describedby={`asset-${slot}-help`}
        className="text-text-13"
      />
      <p id={`asset-${slot}-help`} className="m-0 text-text-12 text-text-secondary">
        {t("assetHelp")}
      </p>
      {state.fieldErrors?.["file"] ? (
        <InlineAlert tone="danger">{tErr(state.fieldErrors["file"])}</InlineAlert>
      ) : null}
      <FormStatus state={state} />
      <div>
        <Button type="submit" size="sm" loading={pending}>
          {t("upload")}
        </Button>
      </div>
    </form>
  );
}

// Domains -----------------------------------------------------------------------------------------

export function AddDomainForm({
  org,
  purposes,
  roles,
}: {
  org: string;
  purposes: readonly { value: string; label: string }[];
  roles?: readonly { value: string; label: string }[];
}) {
  const t = useCopy("settings.domains");
  const tErr = useCopy("settings.errors");
  const [state, action, pending] = useActionState(addDomainAction, INITIAL);
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex flex-col gap-12"
      noValidate
    >
      <input type="hidden" name="org" value={org} />
      <FormStatus state={state} />
      <div className="flex flex-wrap items-end gap-12">
        <Input
          id={`domain-host-${purposes[0]?.value ?? "x"}`}
          name="hostname"
          label={t("hostname")}
          help={t("hostnameHelp")}
          spellCheck={false}
          autoComplete="off"
          error={state.fieldErrors?.["hostname"] ? tErr("hostname") : ""}
        />
        {purposes.length > 1 ? (
          <Select
            id={`domain-purpose-${purposes[0]?.value ?? "x"}`}
            name="purpose"
            label={t("purpose")}
            value={purposes[0]?.value ?? ""}
            options={[...purposes]}
          />
        ) : (
          <input type="hidden" name="purpose" value={purposes[0]?.value ?? ""} />
        )}
        {roles ? (
          <Select
            id="domain-auto-join-role"
            name="autoJoinRoleId"
            label={t("autoJoinRole")}
            value=""
            options={[{ value: "", label: t("autoJoinOff") }, ...roles]}
          />
        ) : null}
      </div>
      <div>
        <Button type="submit" loading={pending}>
          {t("add")}
        </Button>
      </div>
    </form>
  );
}

export function RemoveDomainButton({
  org,
  domainId,
  hostname,
}: {
  org: string;
  domainId: string;
  hostname: string;
}) {
  const t = useCopy("settings.domains");
  const [state, action, pending] = useActionState(removeDomainAction, INITIAL);
  return (
    <form action={action} onSubmit={keepInputOnSubmit(action)} className="flex flex-col gap-4">
      <input type="hidden" name="org" value={org} />
      <input type="hidden" name="domainId" value={domainId} />
      <Button
        type="submit"
        size="sm"
        variant="ghost"
        loading={pending}
        aria-label={t("removeNamed", { hostname })}
      >
        {t("remove")}
      </Button>
      {state.error ? <FormStatus state={state} /> : null}
    </form>
  );
}

// Modules -----------------------------------------------------------------------------------------

export function ModulesForm({
  org,
  modules,
  canEdit,
}: {
  org: string;
  modules: readonly { module: string; label: string; enabled: boolean }[];
  canEdit: boolean;
}) {
  const t = useCopy("settings.modules");
  const [state, action, pending] = useActionState(saveModulesAction, INITIAL);
  return (
    <form
      action={action}
      onSubmit={keepInputOnSubmit(action)}
      className="flex max-w-layout-form flex-col gap-12"
    >
      <input type="hidden" name="org" value={org} />
      <FormStatus state={state} />
      <fieldset className="m-0 flex flex-col divide-y divide-border-subtle border-0 p-0">
        <legend className="mb-8 text-heading-16 font-semibold">{t("legend")}</legend>
        {modules.map((m) => (
          <div key={m.module} className="py-8">
            <input type="hidden" name="module" value={m.module} />
            <Checkbox
              id={`module-${m.module}`}
              name="enabled"
              value={m.module}
              label={m.label}
              defaultChecked={m.enabled}
              disabled={!canEdit}
            />
          </div>
        ))}
      </fieldset>
      <p className="m-0 text-text-12 text-text-secondary">{t("help")}</p>
      {canEdit ? (
        <div>
          <Button type="submit" variant="primary" loading={pending}>
            {t("save")}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

// Legal --------------------------------------------------------------------------------------------

export function AcceptLegalForm({
  org,
  documents,
}: {
  org: string;
  documents: readonly { slug: string; title: string; version: string }[];
}) {
  const t = useCopy("settings.legal");
  const [state, action, pending] = useActionState(acceptLegalAction, INITIAL);
  return (
    <form action={action} onSubmit={keepInputOnSubmit(action)} className="flex flex-col gap-12">
      <input type="hidden" name="org" value={org} />
      {documents.map((d) => (
        <input key={d.slug} type="hidden" name="document" value={d.slug} />
      ))}
      <InlineAlert tone="warning" title={t("pendingTitle")}>
        <ul className="m-0 ps-16">
          {documents.map((d) => (
            <li key={d.slug}>{t("pendingItem", { title: d.title, version: d.version })}</li>
          ))}
        </ul>
      </InlineAlert>
      <FormStatus state={state} />
      <div>
        <Button type="submit" variant="primary" loading={pending}>
          {t("accept")}
        </Button>
      </div>
    </form>
  );
}
