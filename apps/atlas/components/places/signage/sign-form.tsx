"use client";

import { SIGN_TYPES, type Sign } from "@xos/data/signage";
import type { PoLineOption } from "@xos/data/signage";
import { Input, Select, Textarea } from "@xos/ui";
import { useState } from "react";
import { saveSignAction } from "@/app/[org]/places/signage/actions";
import { CustomFieldInputs } from "@/components/custom-fields/inputs";
import { ActionForm, useCopy } from "../kit/form";

export interface PlanChoice {
  readonly id: string;
  readonly title: string;
  readonly projectId: string;
  /** Only a Draft plan takes a new pin (ADR 0140 D1). */
  readonly draft: boolean;
  readonly pins: readonly { readonly id: string; readonly label: string }[];
}

const toUnits = (inches: number | null, metric: boolean) =>
  inches === null ? "" : String(Math.round((metric ? inches * 2.54 : inches) * 10) / 10);

/**
 * Create and edit a sign (G-24): title, type, text, quantity, size in the viewer's units, material, double-sided, its
 * place (a pin of a plan of the project, a new pin on a Draft plan, or words), printer, needed-by day and, for
 * procurement readers only, its purchase order line. With a line linked, the printer is the order's vendor.
 */
export function SignForm({
  org,
  sign,
  projects,
  defaultProjectId,
  plans,
  vendors,
  poLines,
  units,
}: {
  org: string;
  sign?: Sign;
  projects: readonly { readonly id: string; readonly label: string }[];
  defaultProjectId?: string;
  plans: readonly PlanChoice[];
  vendors: readonly { readonly id: string; readonly name: string }[];
  /** Null for a viewer without procurement.po.read: the field is not shown at all. */
  poLines: readonly PoLineOption[] | null;
  units: "imperial" | "metric";
}) {
  const t = useCopy("places");
  const metric = units === "metric";
  const [projectId, setProjectId] = useState(
    sign?.projectId ?? defaultProjectId ?? projects[0]?.id ?? "",
  );
  const pinPlan = sign?.sitePlanPinId
    ? plans.find((p) => p.pins.some((pin) => pin.id === sign.sitePlanPinId))
    : undefined;
  const [planId, setPlanId] = useState(pinPlan?.id ?? "");
  const [pin, setPin] = useState(sign?.sitePlanPinId ?? "");
  const [poLine, setPoLine] = useState(sign?.poLineId ?? "");
  const projectPlans = plans.filter((p) => p.projectId === projectId);
  const plan = projectPlans.find((p) => p.id === planId);
  return (
    <ActionForm
      action={saveSignAction}
      org={org}
      hidden={{
        ...(sign ? { id: sign.id } : {}),
        units,
        ...(planId ? { sitePlanId: planId } : {}),
      }}
      submitLabel={sign ? t("kit.save") : t("signage.create")}
      successMessage={t("kit.saved")}
      onSuccess={(state) => (sign ? null : { create: undefined, peek: state.id })}
    >
      {(error) => (
        <>
          {sign ? null : (
            <Select
              id="sign-project"
              name="projectId"
              label={t("plans.fields.project")}
              value={projectId}
              onChange={(e) => {
                setProjectId(e.currentTarget.value);
                setPlanId("");
                setPin("");
              }}
              options={projects.map((p) => ({ value: p.id, label: p.label }))}
              error={error("projectId")}
            />
          )}
          <Input
            id="sign-title"
            name="title"
            required
            width="100%"
            label={t("signage.fields.title")}
            defaultValue={sign?.title ?? ""}
            error={error("title")}
          />
          <Select
            id="sign-type"
            name="type"
            label={t("signage.fields.type")}
            value={sign?.type ?? "Directional"}
            options={SIGN_TYPES.map((type) => ({ value: type, label: t(`signage.types.${type}`) }))}
            error={error("type")}
          />
          <Textarea
            id="sign-message"
            name="message"
            label={t("signage.fields.message")}
            defaultValue={sign?.message ?? ""}
            width="100%"
            error={error("message")}
          />
          <div className="flex flex-wrap gap-12">
            <Input
              id="sign-quantity"
              name="quantity"
              type="number"
              min="1"
              max="10000"
              step="1"
              label={t("signage.fields.quantity")}
              defaultValue={String(sign?.quantity ?? 1)}
              error={error("quantity")}
            />
            <Input
              id="sign-width"
              name="width"
              type="number"
              min="0"
              step="any"
              label={t(metric ? "signage.fields.widthCm" : "signage.fields.widthIn")}
              defaultValue={toUnits(sign?.widthIn ?? null, metric)}
              error={error("width")}
            />
            <Input
              id="sign-height"
              name="height"
              type="number"
              min="0"
              step="any"
              label={t(metric ? "signage.fields.heightCm" : "signage.fields.heightIn")}
              defaultValue={toUnits(sign?.heightIn ?? null, metric)}
              error={error("height")}
            />
          </div>
          <Input
            id="sign-substrate"
            name="substrate"
            width="100%"
            label={t("signage.fields.substrate")}
            defaultValue={sign?.substrate ?? ""}
            error={error("substrate")}
          />
          <label className="flex min-h-24 items-center gap-8 text-text-13">
            <input type="checkbox" name="doubleSided" defaultChecked={sign?.doubleSided ?? false} />
            {t("signage.fields.doubleSided")}
          </label>
          <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
            <legend className="mb-4 text-text-14 font-semibold">
              {t("signage.fields.location")}
            </legend>
            <Select
              id="sign-plan"
              label={t("signage.fields.plan")}
              value={planId}
              onChange={(e) => {
                setPlanId(e.currentTarget.value);
                setPin("");
              }}
              options={[
                { value: "", label: t("signage.fields.noPlan") },
                ...projectPlans.map((p) => ({ value: p.id, label: p.title })),
              ]}
            />
            {plan ? (
              <Select
                id="sign-pin"
                name="pin"
                label={t("signage.fields.pin")}
                value={pin}
                onChange={(e) => setPin(e.currentTarget.value)}
                options={[
                  { value: "", label: t("signage.fields.noPin") },
                  ...plan.pins.map((p) => ({ value: p.id, label: p.label })),
                  ...(plan.draft ? [{ value: "new", label: t("signage.fields.newPin") }] : []),
                ]}
                error={error("pin")}
              />
            ) : null}
            {pin === "new" ? (
              <div className="flex flex-wrap gap-12">
                <Input
                  id="sign-pin-x"
                  name="pinX"
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  required
                  label={t("plans.fields.x")}
                />
                <Input
                  id="sign-pin-y"
                  name="pinY"
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  required
                  label={t("plans.fields.y")}
                />
              </div>
            ) : null}
            {!pin ? (
              <Input
                id="sign-location"
                name="locationText"
                width="100%"
                label={t("signage.fields.locationText")}
                defaultValue={sign?.locationText ?? ""}
                error={error("locationText")}
              />
            ) : null}
          </fieldset>
          {poLines !== null ? (
            <Select
              id="sign-po-line"
              name="poLineId"
              label={t("signage.fields.poLine")}
              help={t("signage.fields.poLineHelp")}
              value={poLine}
              onChange={(e) => setPoLine(e.currentTarget.value)}
              options={[
                { value: "", label: t("signage.fields.noPoLine") },
                ...poLines.map((l) => ({
                  value: l.id,
                  label: t("signage.fields.poLineOption", {
                    po: l.poNumber,
                    n: l.lineNumber,
                    description: l.description,
                  }),
                })),
              ]}
            />
          ) : null}
          {poLine ? (
            <p className="m-0 text-text-13 text-text-secondary">
              {t("signage.printerFromOrder", {
                vendor: poLines?.find((l) => l.id === poLine)?.vendorName ?? "",
              })}
            </p>
          ) : (
            <Select
              id="sign-printer"
              name="printerVendorId"
              label={t("signage.fields.printer")}
              value={sign?.printerVendorId ?? ""}
              options={[
                { value: "", label: t("signage.fields.noPrinter") },
                ...vendors.map((v) => ({ value: v.id, label: v.name })),
              ]}
            />
          )}
          <Input
            id="sign-needed"
            name="neededBy"
            type="date"
            label={t("signage.fields.neededBy")}
            defaultValue={sign?.neededBy ?? ""}
          />
          {sign ? null : <CustomFieldInputs table="app.signs" />}
        </>
      )}
    </ActionForm>
  );
}
