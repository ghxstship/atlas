import { listCustomFieldDefinitions } from "@xos/data/custom-fields";
import { listDocumentTypes, type DocumentType } from "@xos/data/document-types";
import { listEventTypes, type EventType } from "@xos/data/event-types";
import { listPhases } from "@xos/data/projects";
import { EVENT_AUDIENCES, EVENT_SCALES } from "@xos/data/setup";
import { listTemplates } from "@xos/data/workflow";
import type { ReactNode } from "react";
import { ActionForm } from "@/components/platform/kit";
import { Checkbox, InlineAlert, Input, Select } from "@/components/ui";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import {
  documentTypeAction,
  eventTypeAction,
  eventTypeFieldAction,
  eventTypeRequirementAction,
  eventTypeRuleAction,
} from "./b14-actions";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * B14's panels on Settings, Templates (RRR-238, ADR 0153 D2, D3 and D7):
 *   Event types      the kinds of event the org produces: description and intake guidance, the template each scale
 *                    and audience band starts from ("Any scale", "Any audience"), the project fields intake shows
 *                    (Required by a gate, or shown only) and the document types a project needs; archive and remove
 *   Document types   the kinds of project document the org files, and Add standard types from the XOS Standard
 *                    Library, which adds only names the org does not hold
 * Everyone in the org reads them; forms appear with projects.template.write, and row level security decides each
 * write (3030, 3031). Each form is the platform ActionForm, which keeps typed input after a refusal and names a taken
 * name or a type in use from `platform.refusals`. The panels are peers, so their add buttons are secondary (gate 27).
 */

const P = "projects.eventTypes";
const D = "projects.documentTypes";
const ROW = "flex flex-col gap-8 rounded-card border border-border-subtle p-12";

function Section({ id, title, description, children }: { id: string; title: string; description: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-12">
      <header className="flex flex-col gap-4">
        <h2 id={id} className="m-0 text-heading-16 font-semibold">
          {title}
        </h2>
        <p className="m-0 text-text-13 text-text-secondary">{description}</p>
      </header>
      {children}
    </section>
  );
}

function Edit({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="w-full">
      <summary className="cursor-pointer text-text-13 text-accent-text">{summary}</summary>
      <div className="flex flex-col gap-12 pt-8">{children}</div>
    </details>
  );
}

function TypeFields({ t, idPrefix, type }: { t: Translate; idPrefix: string; type?: EventType }) {
  return (
    <div className="flex flex-col gap-12">
      <Input id={`${idPrefix}-name`} name="name" label={t(`${P}.name`)} defaultValue={type?.name ?? ""} maxLength={100} required />
      <Input
        id={`${idPrefix}-description`}
        name="description"
        label={t(`${P}.description`)}
        help={t(`${P}.descriptionHelp`)}
        defaultValue={type?.description ?? ""}
        maxLength={2000}
        width="100%"
      />
      <Input
        id={`${idPrefix}-guidance`}
        name="intakeGuidance"
        label={t(`${P}.guidance`)}
        help={t(`${P}.guidanceHelp`)}
        defaultValue={type?.intakeGuidance ?? ""}
        maxLength={2000}
        width="100%"
      />
    </div>
  );
}

async function EventTypesPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const db = ctx.viewer.db;
  const canEdit = ctx.capabilities.has("projects.template.write");
  const [types, templates, fields, documentTypes, phases] = await Promise.all([
    listEventTypes(db, ctx.org.id, { includeArchived: true }),
    listTemplates(db, ctx.org.id),
    listCustomFieldDefinitions(db, ctx.org.id, "app.projects"),
    listDocumentTypes(db, ctx.org.id),
    listPhases(db),
  ]);
  const org = ctx.org.slug;
  const gateOptions = (phases.ok ? phases.data : []).map((p) => ({
    value: String(p.gate),
    label: t(`${P}.gateOption`, { gate: p.gate, phase: p.name }),
  }));
  const templateOptions = (templates.ok ? templates.data : [])
    .filter((x) => x.currentVersionId !== null)
    .map((x) => ({ value: x.id, label: x.name }));
  const scaleOptions = [
    { value: "", label: t("projects.intake.anyScale") },
    ...EVENT_SCALES.map((s) => ({ value: s, label: t(`projects.intake.scales.${s}`) })),
  ];
  const audienceOptions = [
    { value: "", label: t("projects.intake.anyAudience") },
    ...EVENT_AUDIENCES.map((a) => ({ value: a, label: t(`projects.intake.audiences.${a.replaceAll(" ", "")}`) })),
  ];
  const band = (value: string | null, options: readonly { value: string; label: string }[]) =>
    options.find((o) => o.value === (value ?? ""))?.label ?? "";
  const gateLabel = (gate: number) => gateOptions.find((o) => o.value === String(gate))?.label ?? String(gate);
  const fieldList = fields.ok ? fields.data : [];
  const docTypes: readonly DocumentType[] = documentTypes.ok ? documentTypes.data : [];

  return (
    <Section id="event-types" title={t(`${P}.title`)} description={t(`${P}.lead`)}>
      {!types.ok ? (
        <InlineAlert tone="danger">{t(`${P}.loadFailed`)}</InlineAlert>
      ) : types.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.empty`)}</p>
      ) : (
        <ul aria-label={t(`${P}.title`)} className="m-0 flex list-none flex-col gap-8 p-0">
          {types.data.map((type) => (
            <li key={type.id} className={ROW}>
              <div className="flex flex-wrap items-baseline justify-between gap-8">
                <span className="text-text-14 font-semibold">{type.name}</span>
                {type.archivedAt ? (
                  <span className="text-text-12 font-medium text-text-secondary">{t(`${P}.archived`)}</span>
                ) : null}
              </div>
              {type.description ? <p className="m-0 text-text-13">{type.description}</p> : null}
              {type.intakeGuidance ? (
                <p className="m-0 text-text-12 text-text-secondary">
                  {t(`${P}.guidanceLine`, { guidance: type.intakeGuidance })}
                </p>
              ) : null}

              <h3 className="m-0 text-text-13 font-semibold">{t(`${P}.rules`)}</h3>
              {type.templates.length === 0 ? (
                <p className="m-0 text-text-12 text-text-secondary">{t(`${P}.noRules`)}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
                  {type.templates.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-8">
                      <span>
                        {t(`${P}.ruleLine`, {
                          scale: band(r.scale, scaleOptions),
                          audience: band(r.audience, audienceOptions),
                          template: r.templateName ?? "",
                        })}
                      </span>
                      {canEdit ? (
                        <ActionForm
                          action={eventTypeRuleAction}
                          hidden={{ org, intent: "remove", eventTypeId: type.id, ruleId: r.id }}
                          label={t(`${P}.removeRule`)}
                          submitLabel={t(`${P}.remove`)}
                          submitVariant="ghost"
                          inline
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              <h3 className="m-0 text-text-13 font-semibold">{t(`${P}.fields`)}</h3>
              {type.fields.length === 0 ? (
                <p className="m-0 text-text-12 text-text-secondary">{t(`${P}.noFields`)}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
                  {type.fields.map((f) => (
                    <li key={f.id} className="flex flex-wrap items-center gap-8">
                      <span>
                        {f.requiredForType
                          ? t(`${P}.fieldRequired`, { label: f.label ?? "", neededBy: gateLabel(f.requiredByGate) })
                          : t(`${P}.fieldShown`, { label: f.label ?? "" })}
                      </span>
                      {canEdit ? (
                        <ActionForm
                          action={eventTypeFieldAction}
                          hidden={{ org, intent: "remove", eventTypeId: type.id, customFieldDefinitionId: f.customFieldDefinitionId }}
                          label={t(`${P}.removeField`, { label: f.label ?? "" })}
                          submitLabel={t(`${P}.remove`)}
                          submitVariant="ghost"
                          inline
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              <h3 className="m-0 text-text-13 font-semibold">{t(`${P}.requirements`)}</h3>
              {type.requirements.length === 0 ? (
                <p className="m-0 text-text-12 text-text-secondary">{t(`${P}.noRequirements`)}</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-4 p-0 text-text-13">
                  {type.requirements.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center gap-8">
                      <span>
                        {t(r.requirement === "Required" ? `${P}.requirementRequired` : `${P}.requirementRecommended`, {
                          name: r.documentTypeName ?? "",
                          neededBy: gateLabel(r.requiredByGate),
                        })}
                      </span>
                      {canEdit ? (
                        <ActionForm
                          action={eventTypeRequirementAction}
                          hidden={{ org, intent: "remove", eventTypeId: type.id, documentTypeId: r.documentTypeId }}
                          label={t(`${P}.removeRequirement`, { name: r.documentTypeName ?? "" })}
                          submitLabel={t(`${P}.remove`)}
                          submitVariant="ghost"
                          inline
                        />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              {canEdit ? (
                <div className="flex flex-wrap items-start gap-16">
                  <Edit summary={t(`${P}.edit`, { name: type.name })}>
                    <ActionForm
                      action={eventTypeAction}
                      hidden={{ org, intent: "update", id: type.id }}
                      label={t(`${P}.edit`, { name: type.name })}
                      submitLabel={t(`${P}.save`)}
                      submitVariant="secondary"
                      success={t(`${P}.saved`)}
                    >
                      <TypeFields t={t} idPrefix={`type-${type.id}`} type={type} />
                    </ActionForm>
                    <ActionForm
                      action={eventTypeRuleAction}
                      hidden={{ org, intent: "add", eventTypeId: type.id }}
                      label={t(`${P}.addRule`)}
                      submitLabel={t(`${P}.addRule`)}
                      submitVariant="secondary"
                      success={t(`${P}.saved`)}
                    >
                      <div className="flex flex-wrap items-end gap-12">
                        <Select id={`rule-${type.id}-scale`} name="scale" label={t("projects.intake.scale")} value="" options={scaleOptions} />
                        <Select id={`rule-${type.id}-audience`} name="audience" label={t("projects.intake.audience")} value="" options={audienceOptions} />
                        <Select
                          id={`rule-${type.id}-template`}
                          name="templateId"
                          label={t(`${P}.template`)}
                          placeholder={t(`${P}.chooseTemplate`)}
                          options={templateOptions}
                        />
                      </div>
                    </ActionForm>
                    {fieldList.length > 0 ? (
                      <ActionForm
                        action={eventTypeFieldAction}
                        hidden={{ org, intent: "add", eventTypeId: type.id }}
                        label={t(`${P}.addField`)}
                        submitLabel={t(`${P}.addField`)}
                        submitVariant="secondary"
                        success={t(`${P}.saved`)}
                      >
                        <div className="flex flex-wrap items-end gap-12">
                          <Select
                            id={`field-${type.id}-definition`}
                            name="customFieldDefinitionId"
                            label={t(`${P}.fieldLabel`)}
                            placeholder={t(`${P}.chooseField`)}
                            options={fieldList.map((f) => ({ value: f.id, label: f.label }))}
                          />
                          <Checkbox name="requiredForType" label={t(`${P}.requiredForType`)} />
                          <Select id={`field-${type.id}-gate`} name="requiredByGate" label={t(`${P}.requiredByGate`)} value="1" options={gateOptions} />
                        </div>
                      </ActionForm>
                    ) : (
                      <p className="m-0 text-text-12 text-text-secondary">{t(`${P}.noProjectFields`)}</p>
                    )}
                    {docTypes.length > 0 ? (
                      <ActionForm
                        action={eventTypeRequirementAction}
                        hidden={{ org, intent: "add", eventTypeId: type.id }}
                        label={t(`${P}.addRequirement`)}
                        submitLabel={t(`${P}.addRequirement`)}
                        submitVariant="secondary"
                        success={t(`${P}.saved`)}
                      >
                        <div className="flex flex-wrap items-end gap-12">
                          <Select
                            id={`requirement-${type.id}-type`}
                            name="documentTypeId"
                            label={t(`${D}.type`)}
                            placeholder={t(`${D}.choose`)}
                            options={docTypes.map((d) => ({ value: d.id, label: d.name }))}
                          />
                          <Select
                            id={`requirement-${type.id}-requirement`}
                            name="requirement"
                            label={t(`${P}.requirement`)}
                            value="Required"
                            options={[
                              { value: "Required", label: t("projects.setup.required") },
                              { value: "Recommended", label: t("projects.setup.recommended") },
                            ]}
                          />
                          <Select id={`requirement-${type.id}-gate`} name="requiredByGate" label={t(`${P}.requiredByGate`)} value="1" options={gateOptions} />
                        </div>
                      </ActionForm>
                    ) : (
                      <p className="m-0 text-text-12 text-text-secondary">{t(`${P}.noDocumentTypes`)}</p>
                    )}
                  </Edit>
                  <ActionForm
                    action={eventTypeAction}
                    hidden={{ org, intent: type.archivedAt ? "restore" : "archive", id: type.id }}
                    label={t(type.archivedAt ? `${P}.restore` : `${P}.archive`, { name: type.name })}
                    submitLabel={t(type.archivedAt ? `${P}.restore` : `${P}.archive`, { name: type.name })}
                    submitVariant="ghost"
                    inline
                  />
                  <ActionForm
                    action={eventTypeAction}
                    hidden={{ org, intent: "remove", id: type.id }}
                    label={t(`${P}.removeType`, { name: type.name })}
                    submitLabel={t(`${P}.removeType`, { name: type.name })}
                    submitVariant="ghost"
                    inline
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className="flex flex-col gap-8">
          <h3 className="m-0 text-text-14 font-semibold">{t(`${P}.addTitle`)}</h3>
          <ActionForm
            action={eventTypeAction}
            hidden={{ org, intent: "create" }}
            label={t(`${P}.addTitle`)}
            submitLabel={t(`${P}.add`)}
            success={t(`${P}.added`)}
            submitVariant="secondary"
          >
            <TypeFields t={t} idPrefix="type-new" />
          </ActionForm>
        </div>
      ) : (
        <p className="m-0 text-text-12 text-text-secondary">{t(`${P}.readOnly`)}</p>
      )}
    </Section>
  );
}

async function DocumentTypesPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const canEdit = ctx.capabilities.has("projects.template.write");
  const types = await listDocumentTypes(ctx.viewer.db, ctx.org.id);
  const org = ctx.org.slug;
  return (
    <Section id="document-types" title={t(`${D}.title`)} description={t(`${D}.lead`)}>
      {!types.ok ? (
        <InlineAlert tone="danger">{t(`${P}.loadFailed`)}</InlineAlert>
      ) : types.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${D}.empty`)}</p>
      ) : (
        <ul aria-label={t(`${D}.title`)} className="m-0 flex list-none flex-col gap-8 p-0">
          {types.data.map((d) => (
            <li key={d.id} className={ROW}>
              <div className="flex flex-wrap items-baseline justify-between gap-8">
                <span className="text-text-14 font-semibold">{d.name}</span>
                {d.standardType ? (
                  <span className="text-text-12 text-text-secondary">{t(`${D}.standard`)}</span>
                ) : null}
              </div>
              {d.description ? <p className="m-0 text-text-13">{d.description}</p> : null}
              {canEdit ? (
                <div className="flex flex-wrap items-start gap-16">
                  <Edit summary={t(`${D}.edit`, { name: d.name })}>
                    <ActionForm
                      action={documentTypeAction}
                      hidden={{ org, intent: "update", id: d.id }}
                      label={t(`${D}.edit`, { name: d.name })}
                      submitLabel={t(`${P}.save`)}
                      submitVariant="secondary"
                      success={t(`${P}.saved`)}
                    >
                      <Input id={`doctype-${d.id}-name`} name="name" label={t(`${D}.name`)} defaultValue={d.name} maxLength={100} required />
                      <Input
                        id={`doctype-${d.id}-description`}
                        name="description"
                        label={t(`${D}.description`)}
                        defaultValue={d.description ?? ""}
                        maxLength={2000}
                        width="100%"
                      />
                    </ActionForm>
                  </Edit>
                  <ActionForm
                    action={documentTypeAction}
                    hidden={{ org, intent: "remove", id: d.id }}
                    label={t(`${D}.remove`, { name: d.name })}
                    submitLabel={t(`${D}.remove`, { name: d.name })}
                    submitVariant="ghost"
                    inline
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canEdit ? (
        <div className="flex flex-col gap-8">
          <ActionForm
            action={documentTypeAction}
            hidden={{ org, intent: "adopt" }}
            label={t(`${D}.adopt`)}
            submitLabel={t(`${D}.adopt`)}
            submitVariant="secondary"
            success={t(`${D}.adopted`)}
            inline
          />
          <h3 className="m-0 text-text-14 font-semibold">{t(`${D}.addTitle`)}</h3>
          <ActionForm
            action={documentTypeAction}
            hidden={{ org, intent: "create" }}
            label={t(`${D}.addTitle`)}
            submitLabel={t(`${D}.add`)}
            success={t(`${P}.added`)}
            submitVariant="secondary"
          >
            <Input id="doctype-new-name" name="name" label={t(`${D}.name`)} maxLength={100} required />
            <Input id="doctype-new-description" name="description" label={t(`${D}.description`)} maxLength={2000} width="100%" />
          </ActionForm>
        </div>
      ) : (
        <p className="m-0 text-text-12 text-text-secondary">{t(`${P}.readOnly`)}</p>
      )}
    </Section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.templates", order: 20, Panel: EventTypesPanel },
  { node: "settings.templates", order: 30, Panel: DocumentTypesPanel },
];
