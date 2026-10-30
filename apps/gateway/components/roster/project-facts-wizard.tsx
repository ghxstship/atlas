"use client";

import {
  SHOE_SIZE_SYSTEMS,
  type Airport,
  type PreviousRosterFacts,
  type ProjectFactKind,
  type RosterProjectFacts,
} from "@xos/data/roster-facts";
import { SHOE_SIZE_SYSTEM_KEYS } from "@xos/data/roster-facts-display";
import { GARMENT_LETTER_SIZES, SEAT_PREFERENCES, workDetailLabelKey } from "@xos/data/work-details";
import {
  Button,
  Checkbox,
  Combobox,
  InlineAlert,
  Input,
  MoreFields,
  Select,
  TemplateWizard,
  Textarea,
} from "@xos/ui";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type ReactNode } from "react";
import {
  clearRosterFactAction,
  previousRosterFactsAction,
  saveRosterTravelAction,
  saveRosterUniformAction,
  saveRosterVehicleAction,
  searchAirportsAction,
  type RosterFactStepState,
} from "@/lib/actions/roster-facts";
import { byKind, stepFields, wizardSteps, type WizardMode } from "@/lib/roster-facts-steps";
import { FactSummary } from "./project-facts-summary";

/**
 * The project facts wizard (R5, ADR 0102): a step for each kind the project offers (travel, uniform sizes, vehicle),
 * then Review. Each Next saves its step on the roster entry and moves on, so nothing is lost between steps. The person
 * may fill a step from their last details without saving. In company mode the roster manager enters a kind for the
 * person, who is notified and can correct it; a kind the person entered shows read-only.
 */

type Translate = (key: string, values?: Record<string, string | number>) => string;

type Value = Pick<RosterProjectFacts, "travel" | "uniform" | "vehicle">;

const SAVE: Record<
  ProjectFactKind,
  (rosterEntryId: string, form: FormData) => Promise<RosterFactStepState>
> = {
  Travel: saveRosterTravelAction,
  Uniform: saveRosterUniformAction,
  Vehicle: saveRosterVehicleAction,
};

export function ProjectFactsWizard({
  facts,
  mode,
  personName,
  projectName,
  onDone,
}: {
  facts: RosterProjectFacts;
  mode: WizardMode;
  personName: string;
  projectName: string;
  onDone?: () => void;
}) {
  const t = useTranslations("workDetails") as unknown as Translate;
  const router = useRouter();
  const steps = wizardSteps(facts, mode);
  const [current, setCurrent] = useState(0);
  const [state, setState] = useState<RosterFactStepState>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<{ value: Value; stamp: number } | null>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const step = steps[Math.min(current, steps.length - 1)] ?? { kind: "Review", readOnly: true };
  const move = (to: number) => {
    setCurrent(to);
    setState({});
    setNotice(null);
    setPrefill(null);
  };
  const next = () => {
    if (step.kind === "Review") {
      if (onDone) onDone();
      else move(0);
      router.refresh();
      return;
    }
    const kind = step.kind;
    if (step.readOnly || !formRef.current) {
      move(current + 1);
      return;
    }
    const form = new FormData(formRef.current);
    startTransition(async () => {
      const result = await SAVE[kind](facts.rosterEntryId, form);
      if (result.ok) {
        move(current + 1);
        router.refresh();
      } else {
        setState(result);
      }
    });
  };
  const fillFromLast = (kind: ProjectFactKind) =>
    startTransition(async () => {
      const previous: PreviousRosterFacts | null = await previousRosterFactsAction(kind);
      if (!previous || previous.value === null) {
        setNotice(t("projectFacts.lastDetailsNone"));
        return;
      }
      setPrefill({ value: { ...facts, [byKind(kind)]: previous.value }, stamp: Date.now() });
      setNotice(t("projectFacts.lastDetailsFilled"));
    });
  const clear = (kind: ProjectFactKind) =>
    startTransition(async () => {
      const result = await clearRosterFactAction(facts.rosterEntryId, kind);
      setState(result.ok ? {} : result);
      if (result.ok) {
        setNotice(t("projectFacts.cleared"));
        router.refresh();
      }
    });
  const fieldError = (name: string) => {
    const code = state.fieldErrors?.[name];
    return code ? t(`errors.${code}`) : undefined;
  };
  const values: Value = prefill?.value ?? facts;
  const stepLabel = (kind: ProjectFactKind | "Review") =>
    t(`projectFacts.steps.${kind.toLowerCase()}`);
  let body: ReactNode;
  if (step.kind === "Review") {
    body = (
      <div className="flex flex-col gap-16">
        <p className="m-0 text-text-14 text-text-secondary">{t("projectFacts.reviewSentence")}</p>
        {steps
          .filter((s) => s.kind !== "Review")
          .map((s) => (
            <section key={s.kind} className="flex flex-col gap-8">
              <h2 className="m-0 text-heading-16 font-semibold">{stepLabel(s.kind)}</h2>
              <FactSummary t={t} kind={s.kind as ProjectFactKind} facts={facts} />
            </section>
          ))}
      </div>
    );
  } else if (step.readOnly) {
    body = (
      <div className="flex flex-col gap-12">
        <InlineAlert tone="info">{t("projectFacts.readOnly", { name: personName })}</InlineAlert>
        <FactSummary t={t} kind={step.kind} facts={facts} />
      </div>
    );
  } else {
    const kind = step.kind;
    const present = facts.present[byKind(kind)];
    body = (
      <form
        ref={formRef}
        key={`${kind}-${prefill?.stamp ?? 0}`}
        className="flex flex-col gap-16"
        aria-label={stepLabel(kind)}
        onSubmit={(e) => {
          e.preventDefault();
          next();
        }}
        noValidate
      >
        <StepForm t={t} kind={kind} facts={facts} values={values} fieldError={fieldError} />
        <div className="flex flex-wrap gap-8">
          {mode === "person" ? (
            <Button type="button" variant="secondary" size="sm" onClick={() => fillFromLast(kind)}>
              {t("projectFacts.useLastDetails")}
            </Button>
          ) : null}
          {present ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => clear(kind)}>
              {t("projectFacts.clear")}
            </Button>
          ) : null}
        </div>
      </form>
    );
  }
  return (
    <TemplateWizard
      steps={steps.map((s) => stepLabel(s.kind))}
      current={current}
      title={
        mode === "company"
          ? t("projectFacts.enterFor", { name: personName })
          : t("projectFacts.wizardTitle", { projectName })
      }
      onBack={() => move(Math.max(0, current - 1))}
      onNext={next}
      nextDisabled={pending}
      finishLabel={t("projectFacts.finish")}
    >
      {mode === "company" ? (
        <InlineAlert tone="info">
          {t("projectFacts.companyBanner", { name: personName })}
        </InlineAlert>
      ) : null}
      {state.error ? <InlineAlert tone="danger">{t(`errors.${state.error}`)}</InlineAlert> : null}
      {notice ? (
        <p role="status" className="m-0 text-text-13 text-text-secondary">
          {notice}
        </p>
      ) : null}
      {body}
    </TemplateWizard>
  );
}

function StepForm({
  t,
  kind,
  facts,
  values,
  fieldError,
}: {
  t: Translate;
  kind: ProjectFactKind;
  facts: RosterProjectFacts;
  values: Value;
  fieldError: (name: string) => string | undefined;
}) {
  const label = (name: string) => t(`projectFacts.fields.${name}.label`);
  const help = (name: string) => t(`projectFacts.fields.${name}.help`);
  const sizes = [
    { value: "", label: t("notSet") },
    ...GARMENT_LETTER_SIZES.map((s) => ({ value: s, label: s })),
  ];
  const err = (name: string) => {
    const e = fieldError(name);
    return e ? { error: e } : {};
  };
  const travel = values.travel;
  const uniform = values.uniform;
  const vehicle = values.vehicle;
  const fields: Record<string, ReactNode> = {
    inboundAirportCode: (
      <AirportField
        t={t}
        name="inboundAirportCode"
        label={label("inboundAirport")}
        help={help("inboundAirport")}
        initial={
          travel?.inboundAirportCode
            ? { code: travel.inboundAirportCode, name: travel.inboundAirportName }
            : null
        }
        error={fieldError("inboundAirportCode")}
      />
    ),
    inboundOn: (
      <Input
        name="inboundOn"
        type="date"
        label={label("inboundOn")}
        help={help("inboundOn")}
        defaultValue={travel?.inboundOn ?? ""}
        {...err("inboundOn")}
      />
    ),
    outboundAirportCode: (
      <AirportField
        t={t}
        name="outboundAirportCode"
        label={label("outboundAirport")}
        help={help("outboundAirport")}
        initial={
          travel?.outboundAirportCode
            ? { code: travel.outboundAirportCode, name: travel.outboundAirportName }
            : null
        }
        error={fieldError("outboundAirportCode")}
      />
    ),
    outboundOn: (
      <Input
        name="outboundOn"
        type="date"
        label={label("outboundOn")}
        help={help("outboundOn")}
        defaultValue={travel?.outboundOn ?? ""}
        {...err("outboundOn")}
      />
    ),
    needsGroundTransport: (
      <Checkbox
        name="needsGroundTransport"
        label={label("needsGroundTransport")}
        defaultChecked={travel?.needsGroundTransport ?? false}
      />
    ),
    needsLodging: (
      <Checkbox
        name="needsLodging"
        label={label("needsLodging")}
        defaultChecked={travel?.needsLodging ?? false}
      />
    ),
    seatPreference: (
      <Select
        name="seatPreference"
        label={label("seatPreference")}
        value={travel?.seatPreference ?? ""}
        options={[
          { value: "", label: t("notSet") },
          ...SEAT_PREFERENCES.map((s) => ({
            value: s,
            label: t(`seatPreferences.${workDetailLabelKey(s)}`),
          })),
        ]}
      />
    ),
    mealPreference: (
      <Input
        name="mealPreference"
        label={label("mealPreference")}
        help={help("mealPreference")}
        maxLength={100}
        defaultValue={travel?.mealPreference ?? ""}
        {...err("mealPreference")}
      />
    ),
    travelNotes: (
      <Textarea
        name="travelNotes"
        label={label("travelNotes")}
        help={help("travelNotes")}
        rows={2}
        width="100%"
        maxLength={500}
        defaultValue={travel?.travelNotes ?? ""}
        {...err("travelNotes")}
      />
    ),
    shirtSize: (
      <Select
        name="shirtSize"
        label={label("shirtSize")}
        value={uniform?.shirtSize ?? ""}
        options={sizes}
      />
    ),
    jacketSize: (
      <Select
        name="jacketSize"
        label={label("jacketSize")}
        value={uniform?.jacketSize ?? ""}
        options={sizes}
      />
    ),
    pantsSize: (
      <Select
        name="pantsSize"
        label={label("pantsSize")}
        value={uniform?.pantsSize ?? ""}
        options={sizes}
      />
    ),
    shoeSize: (
      <Input
        name="shoeSize"
        inputMode="decimal"
        label={label("shoeSize")}
        help={help("shoeSize")}
        width={120}
        defaultValue={uniform && uniform.shoeSize !== null ? String(uniform.shoeSize) : ""}
        {...err("shoeSize")}
      />
    ),
    shoeSizeSystem: (
      <Select
        name="shoeSizeSystem"
        label={label("shoeSizeSystem")}
        value={uniform?.shoeSizeSystem ?? ""}
        options={[
          { value: "", label: t("notSet") },
          ...SHOE_SIZE_SYSTEMS.map((s) => ({
            value: s,
            label: t(`projectFacts.shoeSizeSystems.${SHOE_SIZE_SYSTEM_KEYS[s]}`),
          })),
        ]}
        {...err("shoeSizeSystem")}
      />
    ),
    gloveSize: (
      <Select
        name="gloveSize"
        label={label("gloveSize")}
        value={uniform?.gloveSize ?? ""}
        options={sizes}
      />
    ),
    hatSize: (
      <Select
        name="hatSize"
        label={label("hatSize")}
        value={uniform?.hatSize ?? ""}
        options={sizes}
      />
    ),
    pantsWaistIn: (
      <Input
        name="pantsWaistIn"
        inputMode="numeric"
        label={label("pantsWaistIn")}
        help={help("pantsWaistIn")}
        width={120}
        defaultValue={uniform && uniform.pantsWaistIn !== null ? String(uniform.pantsWaistIn) : ""}
        {...err("pantsWaistIn")}
      />
    ),
    pantsInseamIn: (
      <Input
        name="pantsInseamIn"
        inputMode="numeric"
        label={label("pantsInseamIn")}
        help={help("pantsInseamIn")}
        width={120}
        defaultValue={
          uniform && uniform.pantsInseamIn !== null ? String(uniform.pantsInseamIn) : ""
        }
        {...err("pantsInseamIn")}
      />
    ),
    make: (
      <Input
        name="make"
        label={label("make")}
        help={help("make")}
        maxLength={60}
        defaultValue={vehicle?.make ?? ""}
        {...err("make")}
      />
    ),
    model: (
      <Input
        name="model"
        label={label("model")}
        help={help("model")}
        maxLength={60}
        defaultValue={vehicle?.model ?? ""}
        {...err("model")}
      />
    ),
    color: (
      <Input
        name="color"
        label={label("color")}
        help={help("color")}
        maxLength={30}
        defaultValue={vehicle?.color ?? ""}
        {...err("color")}
      />
    ),
    plate: (
      <Input
        name="plate"
        label={label("plate")}
        help={help("plate")}
        autoComplete="off"
        defaultValue={vehicle?.plate ?? ""}
        {...err("plate")}
      />
    ),
    plateRegion: (
      <Input
        name="plateRegion"
        label={label("plateRegion")}
        help={help("plateRegion")}
        autoComplete="off"
        defaultValue={vehicle?.plateRegion ?? ""}
        {...err("plateRegion")}
      />
    ),
  };
  const plan = stepFields(kind, facts.offered);
  return (
    <>
      <div className="flex flex-wrap items-end gap-12" data-fields="visible">
        {plan.visible.map((name) => (
          <div key={name}>{fields[name]}</div>
        ))}
      </div>
      {plan.more.length > 0 ? (
        <MoreFields>
          <div className="flex flex-wrap items-end gap-12" data-fields="more">
            {plan.more.map((name) => (
              <div key={name} className={name === "travelNotes" ? "w-full" : undefined}>
                {fields[name]}
              </div>
            ))}
          </div>
        </MoreFields>
      ) : null}
    </>
  );
}

/** An airport picked by city, name or code: the list follows a server search as the person types. */
function AirportField({
  t,
  name,
  label,
  help,
  initial,
  error,
}: {
  t: Translate;
  name: string;
  label: string;
  help: string;
  initial: { code: string; name: string | null } | null;
  error: string | undefined;
}) {
  const option = (a: Pick<Airport, "iataCode" | "name" | "municipality">) => ({
    value: a.iataCode,
    label: a.municipality
      ? `${a.name}, ${a.municipality} (${a.iataCode})`
      : `${a.name} (${a.iataCode})`,
  });
  const [code, setCode] = useState(initial?.code ?? "");
  const [options, setOptions] = useState(
    initial
      ? [option({ iataCode: initial.code, name: initial.name ?? initial.code, municipality: null })]
      : [],
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const search = (query: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void searchAirportsAction(query).then((found) => {
        setOptions((prev) => {
          const chosen = prev.filter((o) => o.value === code);
          const fresh = found.map(option).filter((o) => o.value !== code);
          return [...chosen, ...fresh];
        });
      });
    }, 200);
  };
  return (
    <div className="flex flex-col gap-4">
      <input type="hidden" name={name} value={code} />
      <Combobox
        label={label}
        help={help}
        placeholder={t("projectFacts.airportSearch")}
        noMatch={t("projectFacts.airportNoMatch")}
        options={options}
        value={code}
        onChange={setCode}
        onQueryChange={search}
      />
      {error ? <span className="text-text-13 text-danger-text">{error}</span> : null}
    </div>
  );
}
