"use client";

import { resolveTemplate, type EventType } from "@xos/data/event-types";
import { offsetBetween, summarizeProjectCopy, PROJECT_COPY_PARTS } from "@xos/data/project-copy";
import { EVENT_AUDIENCES, EVENT_SCALES } from "@xos/data/setup";
import { Button, Checkbox, Input, MoreFields, Radio, Select, Skeleton, Tag } from "@xos/ui";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ActionState } from "@/lib/projects/actions";
import {
  loadIntakeOptionsAction,
  previewIntakeCopyAction,
  type CopyPreviewState,
  type IntakeOptions,
} from "@/lib/projects/intake";
import { CustomFieldInputs, type CustomFieldInputsHandle } from "@/components/custom-fields/inputs";
import { ActionError, fieldError } from "./action-error";
import { CopyPreviewList } from "./copy-preview-list";
import { ProjectFields, type ProjectFormOptions } from "./project-fields";
import { intakeSteps, stepOfField, type IntakeStep, type StartFrom } from "./intake-steps";

type Translate = (key: string, values?: Record<string, string | number>) => string;

/**
 * New project as a staged intake (B14, G-250; ADR 0153): Start (an event type, or none, and what to start from), Scale
 * and audience, Basics, Details (the type's field set), Copy (from a past project) and Review, all in one form so the
 * last step posts every answer to app.create_project_from_intake in one transaction. An org without event types sees
 * today's single screen, with Start from beside it. Loaded with the New project drawer, never with /projects; the
 * options load when it first opens. A step indicator marks the current step (aria-current="step"), focus moves to each
 * step's heading and a polite live region names the step; Next checks the step's fields first.
 */
export function CreateProjectWizard({
  org,
  options,
  state,
  action,
  pending,
  onCancel,
}: {
  org: string;
  options: ProjectFormOptions;
  state: ActionState;
  action: (form: FormData) => void;
  pending: boolean;
  onCancel: () => void;
}) {
  const t = useTranslations("projects") as unknown as Translate;
  const [intake, setIntake] = useState<IntakeOptions | null>(null);
  const [typeId, setTypeId] = useState<string>("");
  const [startFrom, setStartFrom] = useState<StartFrom>("blank");
  const [scale, setScale] = useState<string>("");
  const [audience, setAudience] = useState<string>("");
  const [templateId, setTemplateId] = useState<string>("");
  const [index, setIndex] = useState(0);
  const [announce, setAnnounce] = useState("");
  const [copyPreview, setCopyPreview] = useState<CopyPreviewState | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const details = useRef<CustomFieldInputsHandle>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const moved = useRef(false);

  useEffect(() => {
    let live = true;
    loadIntakeOptionsAction(org).then(
      (loaded) => live && setIntake(loaded),
      () => live && setIntake({ eventTypes: [], templates: [], pastProjects: [] }),
    );
    return () => {
      live = false;
    };
  }, [org]);

  const type: EventType | null = intake?.eventTypes.find((e) => e.id === typeId) ?? null;
  const staged = (intake?.eventTypes.length ?? 0) > 0 || startFrom !== "blank";
  const steps = intakeSteps({ hasType: type !== null, startFrom });
  const step: IntakeStep = steps[Math.min(index, steps.length - 1)] ?? "start";

  // A refusal or field error the action returns opens the step that holds the field.
  useEffect(() => {
    const names = Object.keys(state.fieldErrors ?? {});
    if (names.length === 0) return;
    const at = steps.indexOf(stepOfField(names[0] ?? ""));
    if (at >= 0) setIndex(at);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new action state moves the wizard
  }, [state]);

  useEffect(() => {
    if (!staged) return;
    setAnnounce(
      t("intake.stepOf", { n: index + 1, total: steps.length, step: t(`intake.steps.${step}`) }),
    );
    if (moved.current) heading.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- announce on a step change only
  }, [index, staged]);

  const go = (next: number) => {
    moved.current = true;
    setIndex(Math.max(0, Math.min(next, steps.length - 1)));
  };

  /** The current step's own fields are valid; the first invalid one says why and takes focus. */
  const stepValid = (): boolean => {
    const box = form.current?.querySelector<HTMLElement>(`[data-step="${step}"]`);
    if (!box) return true;
    for (const el of box.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
    >("input, select, textarea")) {
      if (!el.checkValidity()) {
        el.reportValidity();
        el.focus();
        return false;
      }
    }
    if (step === "details" && details.current && !details.current.check()) return false;
    return true;
  };

  const template = useMemo(() => {
    if (!intake) return null;
    if (startFrom === "template") return intake.templates.find((x) => x.id === templateId) ?? null;
    if (startFrom !== "type" || !type) return null;
    const published = new Set(intake.templates.filter((x) => x.published).map((x) => x.id));
    const rule = resolveTemplate(
      type,
      (scale || null) as never,
      (audience || null) as never,
      (id) => published.has(id),
    );
    return rule ? { id: rule.templateId, name: rule.templateName ?? "", published: true } : null;
  }, [intake, startFrom, templateId, type, scale, audience]);

  if (!intake) {
    return (
      <div className="flex flex-col gap-12" aria-busy="true">
        <Skeleton height={36} />
        <Skeleton height={36} />
        <Skeleton height={120} />
      </div>
    );
  }

  const templateChoice =
    startFrom === "type" && type ? "type" : startFrom === "template" ? "template" : "none";
  const hidden = (name: string, value: string) => <input type="hidden" name={name} value={value} />;

  const startFromOptions = [
    ...(type
      ? [{ value: "type", label: t("intake.startFrom.type"), help: t("intake.startFrom.typeHelp") }]
      : []),
    {
      value: "template",
      label: t("intake.startFrom.template"),
      help: t("intake.startFrom.templateHelp"),
    },
    {
      value: "project",
      label: t("intake.startFrom.project"),
      help: t("intake.startFrom.projectHelp"),
    },
    { value: "blank", label: t("intake.startFrom.blank"), help: t("intake.startFrom.blankHelp") },
  ];

  const startFromField = (
    <Radio
      name="startFrom"
      label={t("intake.startFrom.label")}
      value={startFrom}
      options={startFromOptions}
      onChange={(e) => {
        setStartFrom(e.target.value as StartFrom);
        setIndex(0);
      }}
    />
  );

  const templatePicker =
    startFrom === "template" ? (
      <Select
        id="intake-template"
        name="templateId"
        label={t("intake.template")}
        value={templateId}
        placeholder={t("create.choose")}
        options={intake.templates
          .filter((x) => x.published)
          .map((x) => ({ value: x.id, label: x.name }))}
        onChange={(e) => setTemplateId(e.target.value)}
        error={fieldError(t as never, state, "templateId")}
      />
    ) : (
      hidden("templateId", "")
    );

  const section = (key: IntakeStep, body: ReactNode) => (
    <section
      data-step={key}
      hidden={staged && key !== step}
      className="flex flex-col gap-12"
      aria-labelledby={`intake-${key}`}
    >
      {staged ? (
        <h3
          id={`intake-${key}`}
          ref={key === step ? heading : undefined}
          tabIndex={-1}
          className="m-0 text-text-15 font-semibold"
        >
          {t(`intake.steps.${key}`)}
        </h3>
      ) : null}
      {body}
    </section>
  );

  const loadDays = (
    <MoreFields
      open={Boolean(
        fieldError(t as never, state, "loadInTo") || fieldError(t as never, state, "loadOutTo"),
      )}
    >
      <p className="m-0 text-text-12 text-text-secondary">{t("intake.bumpHelp")}</p>
      <div className="flex flex-wrap gap-12">
        <Input
          id="intake-load-in-from"
          name="loadInFrom"
          type="date"
          width={200}
          label={t("intake.loadInFrom")}
        />
        <Input
          id="intake-load-in-to"
          name="loadInTo"
          type="date"
          width={200}
          label={t("intake.loadInTo")}
          error={fieldError(t as never, state, "loadInTo")}
        />
      </div>
      <div className="flex flex-wrap gap-12">
        <Input
          id="intake-load-out-from"
          name="loadOutFrom"
          type="date"
          width={200}
          label={t("intake.loadOutFrom")}
        />
        <Input
          id="intake-load-out-to"
          name="loadOutTo"
          type="date"
          width={200}
          label={t("intake.loadOutTo")}
          error={fieldError(t as never, state, "loadOutTo")}
        />
      </div>
    </MoreFields>
  );

  const body = !staged ? (
    // An org without event types: today's single screen, with Start from to reach a template or a past project.
    <>
      {startFromField}
      <ProjectFields idPrefix="create" options={options} state={state} />
      <CustomFieldInputs table="app.projects" />
    </>
  ) : (
    <>
      <ol
        className="m-0 flex list-none flex-wrap gap-8 p-0 text-text-12"
        aria-label={t("intake.progress")}
      >
        {steps.map((s, i) => (
          <li
            key={s}
            aria-current={s === step ? "step" : undefined}
            className={s === step ? "font-semibold text-text-primary" : "text-text-secondary"}
          >
            {t("intake.stepNumber", { n: i + 1, step: t(`intake.steps.${s}`) })}
          </li>
        ))}
      </ol>
      {section(
        "start",
        <>
          <Radio
            name="eventTypeChoice"
            label={t("intake.eventType")}
            value={typeId}
            options={[
              ...intake.eventTypes.map((e) => ({
                value: e.id,
                label: e.name,
                ...(e.description ? { help: e.description } : {}),
              })),
              { value: "", label: t("intake.noEventType"), help: t("intake.noEventTypeHelp") },
            ]}
            onChange={(e) => {
              setTypeId(e.target.value);
              setStartFrom(e.target.value ? "type" : "blank");
              setIndex(0);
            }}
          />
          {startFromField}
          {templatePicker}
        </>,
      )}
      {type
        ? section(
            "bands",
            <>
              <Radio
                name="eventScale"
                label={t("intake.scale")}
                value={scale}
                options={EVENT_SCALES.map((s) => ({
                  value: s,
                  label: t(`intake.scales.${s}`),
                  help: t(`intake.scaleBands.${s}`),
                }))}
                onChange={(e) => setScale(e.target.value)}
              />
              <Radio
                name="eventAudience"
                label={t("intake.audience")}
                value={audience}
                options={EVENT_AUDIENCES.map((a) => ({
                  value: a,
                  label: t(`intake.audiences.${a.replaceAll(" ", "")}`),
                  help: t(`intake.audienceHelp.${a.replaceAll(" ", "")}`),
                }))}
                onChange={(e) => setAudience(e.target.value)}
              />
            </>,
          )
        : null}
      {section(
        "basics",
        <>
          <ProjectFields idPrefix="create" options={options} state={state} />
          {loadDays}
        </>,
      )}
      {section(
        "details",
        <>
          {type?.intakeGuidance ? (
            <p className="m-0 text-text-13 text-text-secondary">{type.intakeGuidance}</p>
          ) : null}
          <CustomFieldInputs
            ref={details}
            table="app.projects"
            {...(type
              ? {
                  fieldKeys: type.fields.map((f) => f.fieldKey ?? "").filter(Boolean),
                  requiredKeys: type.fields
                    .filter((f) => f.requiredForType)
                    .map((f) => f.fieldKey ?? "")
                    .filter(Boolean),
                }
              : {})}
          />
        </>,
      )}
      {startFrom === "project"
        ? section(
            "copy",
            <CopyStep
              org={org}
              intake={intake}
              form={form}
              state={state}
              preview={copyPreview}
              setPreview={setCopyPreview}
            />,
          )
        : null}
      {section(
        "review",
        <ReviewStep
          type={type}
          template={template}
          startFrom={startFrom}
          copy={startFrom === "project" ? copyPreview : null}
        />,
      )}
    </>
  );

  const last = !staged || step === "review";
  return (
    <form
      ref={form}
      id="create-project"
      action={action}
      className="flex flex-col gap-12"
      noValidate
      onSubmit={(e) => {
        // Enter in a field moves to the next step until the last one, which creates the project.
        if (!last) {
          e.preventDefault();
          if (stepValid()) go(index + 1);
        }
      }}
    >
      <input type="hidden" name="org" value={org} />
      {hidden("eventTypeId", type ? type.id : "")}
      {hidden("templateChoice", templateChoice)}
      {type ? null : (
        <>
          {hidden("eventScale", "")}
          {hidden("eventAudience", "")}
        </>
      )}
      <p className="m-0 text-text-13 text-text-secondary">{t("create.description")}</p>
      <ActionError state={state} />
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      {body}
      <div className="sticky bottom-0 flex flex-wrap justify-end gap-8 border-t border-border-subtle bg-bg-surface pt-12">
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("create.cancel")}
        </Button>
        {staged && index > 0 ? (
          <Button type="button" variant="secondary" onClick={() => go(index - 1)}>
            {t("intake.back")}
          </Button>
        ) : null}
        {last ? (
          <Button type="submit" variant="primary" loading={pending}>
            {t("create.submit")}
          </Button>
        ) : (
          <Button type="button" variant="primary" onClick={() => stepValid() && go(index + 1)}>
            {t("intake.next")}
          </Button>
        )}
      </div>
    </form>
  );
}

/** The Copy step: a past project, the parts and the offset, and a preview against the project about to be made. */
function CopyStep({
  org,
  intake,
  form,
  state,
  preview,
  setPreview,
}: {
  org: string;
  intake: IntakeOptions;
  form: RefObject<HTMLFormElement | null>;
  state: ActionState;
  preview: CopyPreviewState | null;
  setPreview: (preview: CopyPreviewState | null) => void;
}) {
  const t = useTranslations("projects") as unknown as Translate;
  const [source, setSource] = useState("");
  const [parts, setParts] = useState<readonly string[]>(PROJECT_COPY_PARTS);
  const [offset, setOffset] = useState("");
  const [busy, setBusy] = useState(false);
  const read = (name: string) => {
    const value = form.current ? new FormData(form.current).get(name) : null;
    return typeof value === "string" && value !== "" ? value : null;
  };
  const prefill = (id: string) => {
    const from = intake.pastProjects.find((p) => p.id === id)?.startsOn ?? null;
    const days = offsetBetween(from, read("startsOn"));
    setOffset(days === null ? "" : String(days));
  };
  return (
    <>
      <Select
        id="intake-copy-source"
        name="copyFromProjectId"
        label={t("copy.source")}
        value={source}
        placeholder={t("create.choose")}
        options={intake.pastProjects.map((p) => ({
          value: p.id,
          label: `${p.key} ${p.name}${p.archived ? ` (${t("copy.archived")})` : ""}`,
        }))}
        onChange={(e) => {
          setSource(e.target.value);
          setPreview(null);
          prefill(e.target.value);
        }}
      />
      <fieldset className="m-0 flex flex-col gap-8 border-0 p-0">
        <legend className="mb-8 text-text-13 font-medium">{t("copy.parts")}</legend>
        {PROJECT_COPY_PARTS.map((part) => (
          <Checkbox
            key={part}
            name="copyParts"
            value={part}
            checked={parts.includes(part)}
            onChange={(e) => {
              setParts((now) =>
                e.target.checked ? [...now, part] : now.filter((p) => p !== part),
              );
              setPreview(null);
            }}
            label={t(`copy.partNames.${part.replaceAll(" ", "")}`)}
          />
        ))}
        {fieldError(t as never, state, "copyParts") ? (
          <p className="m-0 text-text-12 text-danger">
            {fieldError(t as never, state, "copyParts")}
          </p>
        ) : null}
      </fieldset>
      <Input
        id="intake-copy-offset"
        name="copyOffsetDays"
        type="number"
        min={-3660}
        max={3660}
        width={200}
        label={t("copy.offset")}
        help={t("copy.offsetHelp")}
        value={offset}
        onChange={(e) => {
          setOffset(e.target.value);
          setPreview(null);
        }}
        error={fieldError(t as never, state, "copyOffsetDays")}
      />
      <div>
        <Button
          type="button"
          variant="secondary"
          loading={busy}
          disabled={!source || parts.length === 0}
          onClick={async () => {
            setBusy(true);
            setPreview(
              await previewIntakeCopyAction(org, {
                sourceProjectId: source,
                parts,
                offsetDays: offset === "" ? null : Number(offset),
                venueId: read("venueId"),
                timeZone: read("timeZone"),
              }),
            );
            setBusy(false);
          }}
        >
          {t("copy.preview")}
        </Button>
      </div>
      {preview ? <CopyPreviewList preview={preview} /> : null}
    </>
  );
}

/** The Review step: the template that will be applied and what the type requires, by gate. */
function ReviewStep({
  type,
  template,
  startFrom,
  copy,
}: {
  type: EventType | null;
  template: { readonly name: string } | null;
  startFrom: StartFrom;
  copy: CopyPreviewState | null;
}) {
  const t = useTranslations("projects") as unknown as Translate;
  const rows = [
    ...(type?.requirements ?? []).map((r) => ({
      key: r.id,
      label: r.documentTypeName ?? "",
      kind: t("intake.review.document"),
      requirement: r.requirement,
      gate: r.requiredByGate,
    })),
    ...(type?.fields ?? []).map((f) => ({
      key: f.id,
      label: f.label ?? f.fieldKey ?? "",
      kind: t("intake.review.field"),
      requirement: f.requiredForType ? ("Required" as const) : ("Recommended" as const),
      gate: f.requiredByGate,
    })),
  ];
  return (
    <dl className="m-0 flex flex-col gap-8 text-text-13">
      <div>
        <dt className="font-medium">{t("intake.review.template")}</dt>
        <dd className="m-0 text-text-secondary">
          {template
            ? template.name
            : startFrom === "project"
              ? t("intake.review.fromProject")
              : t("intake.review.blank")}
        </dd>
      </div>
      {copy?.ok ? (
        <div>
          <dt className="font-medium">{t("intake.review.copy")}</dt>
          <dd className="m-0 text-text-secondary">
            {summarizeProjectCopy(copy.items)
              .map((p) =>
                t("copy.partSummary", {
                  part: t(`copy.partNames.${p.part.replaceAll(" ", "")}`),
                  copied: p.copied,
                  skipped: p.skipped,
                }),
              )
              .join("; ")}
          </dd>
        </div>
      ) : null}
      {rows.length > 0 ? (
        <div>
          <dt className="font-medium">{t("intake.review.requirements")}</dt>
          <dd className="m-0">
            <ul className="m-0 flex list-none flex-col gap-4 p-0">
              {rows.map((r) => (
                <li key={r.key} className="flex flex-wrap items-center gap-6">
                  <Tag tone={r.requirement === "Required" ? "warning" : "neutral"}>
                    {t(r.requirement === "Required" ? "setup.required" : "setup.recommended")}
                  </Tag>
                  <span>{r.label}</span>
                  <span className="text-text-secondary">
                    {t("setup.itemMeta", { kind: r.kind, gate: r.gate })}
                  </span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
      ) : null}
    </dl>
  );
}
