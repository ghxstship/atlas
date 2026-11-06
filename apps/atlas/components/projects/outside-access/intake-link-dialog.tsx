"use client";

import { Button, Dialog, InlineAlert, Input, MultiSelect, Select, Textarea } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useActionState, useEffect, useMemo, useState } from "react";
import { keepInputOnSubmit } from "@/components/collection-kit/keep-input";
import {
  createIntakeLinkAction,
  intakeOptionsAction,
  type IntakeOptions,
  type ProjectKeyRef,
  type Revealed,
} from "@/lib/outside-access/actions";

type Translate = ((key: string, values?: Record<string, string | number>) => string) & {
  has?: (key: string) => boolean;
};

interface Who {
  title: string;
  instructions: string;
  roleType: "Vendor" | "Contractor";
  counterpartyType: string;
  startDate: string;
  endDate: string;
}
interface Terms {
  roleCode: string;
  classification: string;
  payBasis: string;
  arrangement: string;
  agreementDocumentId: string;
}

const uniq = (values: readonly (string | null)[]) => [
  ...new Set(values.filter((v): v is string => !!v)),
];

/**
 * A new vendor intake link (B2, ADR 0141), in three steps, each its own dialog body with only the current step mounted,
 * so no screen shows more than seven fields (gate 27). The rate card fields cascade, each keyed to the one before so
 * its default resets. The link, code and QR go to the section's reveal panel.
 */
export function IntakeLinkDialog({
  refs,
  onReveal,
  onClose,
}: {
  refs: ProjectKeyRef;
  onReveal: (revealed: Revealed) => void;
  onClose: () => void;
}) {
  const t = useTranslations("projects.outsideAccess.intake") as unknown as Translate;
  const errors = useTranslations("projects.outsideAccess.errors") as unknown as Translate;
  const [options, setOptions] = useState<IntakeOptions | null>(null);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [who, setWho] = useState<Who>({
    title: "",
    instructions: "",
    roleType: "Vendor",
    counterpartyType: "",
    startDate: "",
    endDate: "",
  });
  const [terms, setTerms] = useState<Terms>({
    roleCode: "",
    classification: "",
    payBasis: "",
    arrangement: "",
    agreementDocumentId: "",
  });
  const [collect, setCollect] = useState<string[]>(["tax", "payout"]);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    void intakeOptionsAction(refs).then((r) => (r.ok ? setOptions(r.data) : setLoadError(r.error)));
  }, [refs]);

  const rows = useMemo(() => options?.rateCard ?? [], [options]);
  const roles = useMemo(
    () =>
      uniq(rows.map((r) => r.roleCode)).map((code) => ({
        value: code,
        label: rows.find((r) => r.roleCode === code)?.roleLabel ?? code,
      })),
    [rows],
  );
  const classes = uniq(
    rows.filter((r) => r.roleCode === terms.roleCode).map((r) => r.classification),
  );
  const bases = uniq(
    rows
      .filter((r) => r.roleCode === terms.roleCode && r.classification === terms.classification)
      .map((r) => r.payBasis),
  );
  const arrangements = uniq(
    rows
      .filter(
        (r) =>
          r.roleCode === terms.roleCode &&
          r.classification === terms.classification &&
          r.payBasis === terms.payBasis,
      )
      .map((r) => r.arrangement),
  );

  const [state, dispatch, pending] = useActionState(
    async (_s: { error: string | null }, data: FormData) => {
      const result = await createIntakeLinkAction(refs, {
        title: who.title,
        roleType: who.roleType,
        roleCode: terms.roleCode,
        workerClassification: terms.classification,
        payBasis: terms.payBasis === "" ? null : terms.payBasis,
        arrangement: terms.arrangement === "" ? null : terms.arrangement,
        startDate: who.startDate,
        endDate: who.endDate === "" ? null : who.endDate,
        expiresOn: String(data.get("expiresOn") ?? ""),
        counterpartyType:
          who.roleType === "Vendor" && who.counterpartyType !== "" ? who.counterpartyType : null,
        agreementDocumentId: terms.agreementDocumentId === "" ? null : terms.agreementDocumentId,
        instructions: who.instructions === "" ? null : who.instructions,
        note: null,
        collectTaxForm: collect.includes("tax"),
        collectPayout: collect.includes("payout"),
        collectInvoice: collect.includes("invoice"),
        maxRequests: Number(data.get("maxRequests") ?? 50),
      });
      if (!result.ok) return { error: result.error };
      onReveal(result.data);
      onClose();
      return { error: null };
    },
    { error: null },
  );

  const refusal = loadError ?? state.error;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t("title")}
      description={t(`steps.${step}`)}
      actions={
        <Button type="button" variant="secondary" onClick={onClose}>
          {t("close")}
        </Button>
      }
    >
      <div className="flex flex-col gap-16">
        {refusal ? (
          <InlineAlert tone="danger">
            {errors.has?.(refusal) === false ? errors("unexpected") : errors(refusal)}
          </InlineAlert>
        ) : null}
        {step === 1 ? (
          <form
            className="flex flex-col gap-8"
            action={(data) => {
              setWho({
                title: String(data.get("title") ?? ""),
                instructions: String(data.get("instructions") ?? ""),
                roleType: data.get("roleType") === "Contractor" ? "Contractor" : "Vendor",
                counterpartyType: String(data.get("counterpartyType") ?? ""),
                startDate: String(data.get("startDate") ?? ""),
                endDate: String(data.get("endDate") ?? ""),
              });
              setStep(2);
            }}
            onSubmit={keepInputOnSubmit((data) => {
              setWho({
                title: String(data.get("title") ?? ""),
                instructions: String(data.get("instructions") ?? ""),
                roleType: data.get("roleType") === "Contractor" ? "Contractor" : "Vendor",
                counterpartyType: String(data.get("counterpartyType") ?? ""),
                startDate: String(data.get("startDate") ?? ""),
                endDate: String(data.get("endDate") ?? ""),
              });
              setStep(2);
            })}
          >
            <Input
              id="intake-title"
              name="title"
              label={t("linkTitle")}
              defaultValue={who.title}
              maxLength={120}
              required
              width="100%"
            />
            <Textarea
              id="intake-instructions"
              name="instructions"
              label={t("instructions")}
              help={t("instructionsHelp")}
              defaultValue={who.instructions}
              maxLength={2000}
            />
            <Select
              id="intake-role-type"
              name="roleType"
              label={t("roleType")}
              value={who.roleType}
              onChange={(event) =>
                setWho((w) => ({
                  ...w,
                  roleType: event.target.value === "Contractor" ? "Contractor" : "Vendor",
                }))
              }
              options={[
                { value: "Vendor", label: t("roleTypes.Vendor") },
                { value: "Contractor", label: t("roleTypes.Contractor") },
              ]}
            />
            {who.roleType === "Vendor" ? (
              <Select
                id="intake-counterparty-type"
                name="counterpartyType"
                label={t("counterpartyType")}
                placeholder={t("pick")}
                value={who.counterpartyType}
                options={(options?.counterpartyTypes ?? []).map((c) => ({ value: c, label: c }))}
              />
            ) : null}
            <Input
              id="intake-start"
              name="startDate"
              type="date"
              label={t("startDate")}
              defaultValue={who.startDate}
              required
            />
            <Input
              id="intake-end"
              name="endDate"
              type="date"
              label={t("endDate")}
              defaultValue={who.endDate}
            />
            <div>
              <Button type="submit" variant="primary">
                {t("next")}
              </Button>
            </div>
          </form>
        ) : step === 2 ? (
          <div className="flex flex-col gap-8">
            <Select
              id="intake-role"
              label={t("role")}
              placeholder={t("pick")}
              value={terms.roleCode}
              onChange={(event) =>
                setTerms({
                  ...terms,
                  roleCode: event.target.value,
                  classification: "",
                  payBasis: "",
                  arrangement: "",
                })
              }
              options={roles}
            />
            <Select
              key={`class-${terms.roleCode}`}
              id="intake-classification"
              label={t("classification")}
              placeholder={t("pick")}
              value={terms.classification}
              onChange={(event) =>
                setTerms({
                  ...terms,
                  classification: event.target.value,
                  payBasis: "",
                  arrangement: "",
                })
              }
              options={classes.map((c) => ({ value: c, label: c }))}
            />
            <Select
              key={`basis-${terms.classification}`}
              id="intake-pay-basis"
              label={t("payBasis")}
              placeholder={t("pick")}
              value={terms.payBasis}
              onChange={(event) =>
                setTerms({ ...terms, payBasis: event.target.value, arrangement: "" })
              }
              options={bases.map((c) => ({ value: c, label: c }))}
            />
            <Select
              key={`arrangement-${terms.payBasis}`}
              id="intake-arrangement"
              label={t("arrangement")}
              placeholder={t("pick")}
              value={terms.arrangement}
              onChange={(event) => setTerms({ ...terms, arrangement: event.target.value })}
              options={arrangements.map((c) => ({ value: c, label: c }))}
            />
            <Select
              id="intake-agreement"
              label={t("agreement")}
              help={t("agreementHelp")}
              value={terms.agreementDocumentId}
              onChange={(event) => setTerms({ ...terms, agreementDocumentId: event.target.value })}
              options={[
                { value: "", label: t("noAgreement") },
                ...(options?.documents ?? []).map((d) => ({ value: d.id, label: d.title })),
              ]}
            />
            <div className="flex gap-8">
              <Button type="button" variant="secondary" onClick={() => setStep(1)}>
                {t("back")}
              </Button>
              <Button
                type="button"
                variant="primary"
                disabled={!terms.roleCode || !terms.classification}
                onClick={() => setStep(3)}
              >
                {t("next")}
              </Button>
            </div>
          </div>
        ) : (
          <form
            action={dispatch}
            onSubmit={keepInputOnSubmit(dispatch)}
            className="flex flex-col gap-8"
          >
            <MultiSelect
              id="intake-collect"
              label={t("collect")}
              value={collect}
              onChange={setCollect}
              options={[
                { value: "tax", label: t("collects.tax") },
                { value: "payout", label: t("collects.payout") },
                { value: "invoice", label: t("collects.invoice") },
              ]}
            />
            <Input
              id="intake-expires"
              name="expiresOn"
              type="date"
              label={t("expiresOn")}
              help={t("expiresHelp")}
              min={options?.today}
              max={options?.lastDay}
              required
            />
            <Input
              id="intake-max"
              name="maxRequests"
              type="number"
              min={1}
              max={500}
              defaultValue={50}
              label={t("maxRequests")}
            />
            <div className="flex gap-8">
              <Button type="button" variant="secondary" onClick={() => setStep(2)}>
                {t("back")}
              </Button>
              <Button type="submit" variant="primary" loading={pending}>
                {t("create")}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}
