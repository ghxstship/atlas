import { RATE_TYPES, VISIBILITIES } from "@xos/data/opportunities";
import {
  getOpportunityDefaults,
  listQuestionTemplates,
  type OpportunityDefaults,
  type QuestionTemplate,
} from "@xos/data/opportunity-templates";
import { resolveSettings } from "@xos/data/settings";
import { getTranslations } from "next-intl/server";
import { ActionForm } from "@/components/opportunities/action-form";
import { Muted, RowLink } from "@/components/opportunities/parts";
import { InlineAlert, Tag } from "@/components/opportunities/ui";
import { enumKey } from "@/lib/opportunities/format";
import type { Translate } from "@/lib/opportunities/page";
import { allowedVisibilities } from "@/lib/shell/org-settings";
import { nodeHref } from "@/lib/shell/sitemap";
import {
  addTemplateQuestionAction,
  createQuestionTemplateAction,
  deleteQuestionTemplateAction,
  removeTemplateQuestionAction,
  saveOpportunityDefaultsAction,
} from "./a136-actions";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * A136's settings panel (ADR 0021 item 7, ADR 0113): Settings, Gateway and Marketplace holds how the org's new
 * opportunities start (Section 4.5.6 item 27). The defaults (visibility, pay basis, application window and question
 * template) prefill the posting form, where each stays editable; a question template's questions are copied into each
 * posting created from it. People who create postings read the panel; marketplace managers change it. Pools and
 * onboarding requirements, the other parts of how an org engages, are linked from here.
 */

async function OpportunityStartPanel({ ctx, params }: SettingsPanelProps) {
  const canManage = ctx.capabilities.has("opportunities.marketplace.manage");
  if (!canManage && !ctx.capabilities.has("opportunities.posting.read")) return null;
  const [translations, defaults, templates, settings] = await Promise.all([
    getTranslations("opportunities"),
    getOpportunityDefaults(ctx.viewer.db, ctx.org.id),
    listQuestionTemplates(ctx.viewer.db, ctx.org.id),
    resolveSettings(ctx.viewer.db, { orgId: ctx.org.id }),
  ]);
  const t = translations as unknown as Translate;
  const pools = nodeHref("opportunities.pools", params);
  const onboarding = nodeHref("opportunities.onboarding", params);
  return (
    <section
      aria-labelledby="opportunity-start"
      className="flex flex-col gap-16"
      data-testid="opportunity-start"
    >
      <header className="flex flex-col gap-4">
        <h2 id="opportunity-start" className="m-0 text-heading-16 font-semibold">
          {t("templates.title")}
        </h2>
        <p className="m-0 text-text-secondary">{t("templates.description")}</p>
        {pools || onboarding ? (
          <p className="m-0 flex flex-wrap gap-12 text-text-13">
            {pools ? <RowLink href={pools}>{t("templates.poolsLink")}</RowLink> : null}
            {onboarding ? (
              <RowLink href={onboarding}>{t("templates.onboardingLink")}</RowLink>
            ) : null}
          </p>
        ) : null}
      </header>
      {!defaults.ok || !templates.ok ? (
        <InlineAlert tone="danger">{t("templates.loadError")}</InlineAlert>
      ) : (
        <>
          <Defaults
            t={t}
            org={ctx.org.slug}
            defaults={defaults.data}
            templates={templates.data}
            visibilities={allowedVisibilities(
              (key) => (settings.ok ? settings.data.get(key)?.value : undefined),
              VISIBILITIES,
            )}
            canManage={canManage}
          />
          <Templates t={t} org={ctx.org.slug} templates={templates.data} canManage={canManage} />
        </>
      )}
    </section>
  );
}

function Defaults({
  t,
  org,
  defaults,
  templates,
  visibilities,
  canManage,
}: {
  t: Translate;
  org: string;
  defaults: OpportunityDefaults;
  templates: readonly QuestionTemplate[];
  visibilities: readonly OpportunityDefaults["visibility"][];
  canManage: boolean;
}) {
  const template = templates.find((tpl) => tpl.id === defaults.questionTemplateId);
  return (
    <div className="flex flex-col gap-8" data-testid="opportunity-defaults">
      <h3 className="m-0 text-text-14 font-semibold">{t("templates.defaultsTitle")}</h3>
      {canManage ? (
        <ActionForm
          action={saveOpportunityDefaultsAction}
          hidden={{ org }}
          title={t("templates.defaultsForm")}
          submitLabel={t("templates.saveDefaults")}
          successLabel={t("templates.defaultsSaved")}
          fields={[
            {
              name: "visibility",
              label: t("fields.visibility"),
              kind: "select",
              defaultValue: defaults.visibility,
              help: t("templates.visibilityHelp"),
              options: visibilities.map((v) => ({
                value: v,
                label: t(`visibilities.${enumKey(v)}`),
              })),
            },
            {
              name: "rateType",
              label: t("templates.payBasis"),
              kind: "select",
              defaultValue: defaults.rateType ?? "",
              options: [
                { value: "", label: t("rateOnRequest") },
                ...RATE_TYPES.map((r) => ({ value: r, label: t(`rateTypes.${enumKey(r)}`) })),
              ],
            },
            {
              name: "currencyCode",
              label: t("fields.currency"),
              kind: "text",
              defaultValue: defaults.currencyCode ?? "",
              help: t("templates.currencyHelp"),
            },
            {
              name: "applicationWindowDays",
              label: t("templates.window"),
              kind: "number",
              min: 1,
              max: 365,
              defaultValue:
                defaults.applicationWindowDays === null
                  ? ""
                  : String(defaults.applicationWindowDays),
              help: t("templates.windowHelp"),
            },
            {
              name: "questionTemplateId",
              label: t("postings.questionTemplate"),
              kind: "select",
              defaultValue: defaults.questionTemplateId ?? "",
              options: [
                { value: "", label: t("postings.noQuestionTemplate") },
                ...templates.map((tpl) => ({ value: tpl.id, label: tpl.name })),
              ],
            },
            {
              name: "hideClientUntilBooked",
              label: t("fields.hideClientUntilBooked"),
              kind: "checkbox",
              defaultValue: defaults.hideClientUntilBooked ? "true" : "",
              help: t("templates.hideClientHelp"),
            },
          ]}
        />
      ) : (
        <dl className="m-0 grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)] gap-x-12 gap-y-8 text-text-13">
          <dt className="text-text-secondary">{t("fields.visibility")}</dt>
          <dd className="m-0">{t(`visibilities.${enumKey(defaults.visibility)}`)}</dd>
          <dt className="text-text-secondary">{t("templates.payBasis")}</dt>
          <dd className="m-0">
            {defaults.rateType ? t(`rateTypes.${enumKey(defaults.rateType)}`) : t("rateOnRequest")}
            {defaults.currencyCode ? ` · ${defaults.currencyCode}` : ""}
          </dd>
          <dt className="text-text-secondary">{t("templates.window")}</dt>
          <dd className="m-0">
            {defaults.applicationWindowDays === null
              ? t("templates.noWindow")
              : t("templates.windowDays", { count: defaults.applicationWindowDays })}
          </dd>
          <dt className="text-text-secondary">{t("postings.questionTemplate")}</dt>
          <dd className="m-0">{template?.name ?? t("postings.noQuestionTemplate")}</dd>
          <dt className="text-text-secondary">{t("fields.hideClientUntilBooked")}</dt>
          <dd className="m-0">{defaults.hideClientUntilBooked ? t("yes") : t("no")}</dd>
        </dl>
      )}
      {!canManage ? <Muted>{t("templates.managersOnly")}</Muted> : null}
    </div>
  );
}

function Templates({
  t,
  org,
  templates,
  canManage,
}: {
  t: Translate;
  org: string;
  templates: readonly QuestionTemplate[];
  canManage: boolean;
}) {
  return (
    <div className="flex flex-col gap-12" data-testid="question-templates">
      <h3 className="m-0 text-text-14 font-semibold">
        {t("templates.listTitle", { count: templates.length })}
      </h3>
      <Muted>{t("templates.listHelp")}</Muted>
      {templates.length === 0 ? <Muted>{t("templates.none")}</Muted> : null}
      <ul className="m-0 flex list-none flex-col gap-12 p-0">
        {templates.map((tpl) => {
          const next = Math.min(999, (tpl.questions.at(-1)?.sortOrder ?? 0) + 1);
          return (
            <li
              key={tpl.id}
              aria-label={tpl.name}
              className="flex flex-col gap-8 rounded-card border border-border-subtle p-12"
            >
              <div className="flex flex-wrap items-start justify-between gap-8">
                <div className="flex min-w-0 flex-col gap-2">
                  <p className="m-0 text-text-14 font-semibold">{tpl.name}</p>
                  {tpl.description ? (
                    <p className="m-0 text-text-13 text-text-secondary">{tpl.description}</p>
                  ) : null}
                </div>
                {canManage ? (
                  <ActionForm
                    action={deleteQuestionTemplateAction}
                    hidden={{ org, templateId: tpl.id }}
                    fields={[]}
                    submitLabel={t("templates.delete")}
                    variant="danger"
                    inline
                  />
                ) : null}
              </div>
              {tpl.questions.length === 0 ? (
                <Muted>{t("templates.noQuestions")}</Muted>
              ) : (
                <ol
                  className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0"
                  aria-label={t("templates.questionsOf", { name: tpl.name })}
                >
                  {tpl.questions.map((q) => (
                    <li
                      key={q.id}
                      className="flex flex-wrap items-center justify-between gap-8 py-6 text-text-13"
                    >
                      <span className="flex min-w-0 items-center gap-8">
                        <span className="tabular-nums text-text-secondary">{q.sortOrder}</span>
                        <span className="min-w-0 break-words">{q.prompt}</span>
                        {q.required ? <Tag>{t("postings.required")}</Tag> : null}
                      </span>
                      {canManage ? (
                        <ActionForm
                          action={removeTemplateQuestionAction}
                          hidden={{ org, questionId: q.id }}
                          fields={[]}
                          submitLabel={t("remove")}
                          inline
                        />
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
              {canManage ? (
                <ActionForm
                  action={addTemplateQuestionAction}
                  hidden={{ org, templateId: tpl.id }}
                  inline
                  submitLabel={t("postings.addQuestion")}
                  fields={[
                    {
                      name: "prompt",
                      label: t("fields.question"),
                      kind: "text",
                      required: true,
                      help: t("postings.questionHelp"),
                    },
                    {
                      name: "sortOrder",
                      label: t("fields.order"),
                      kind: "number",
                      min: 1,
                      max: 999,
                      defaultValue: String(next),
                    },
                    { name: "required", label: t("postings.required"), kind: "checkbox" },
                  ]}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {canManage ? (
        <ActionForm
          action={createQuestionTemplateAction}
          hidden={{ org }}
          title={t("templates.new")}
          submitLabel={t("templates.create")}
          successLabel={t("templates.created")}
          fields={[
            {
              name: "name",
              label: t("fields.name"),
              kind: "text",
              required: true,
              help: t("templates.nameHelp"),
            },
            { name: "description", label: t("fields.description"), kind: "textarea" },
          ]}
        />
      ) : null}
    </div>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.gateway-and-marketplace", order: 40, Panel: OpportunityStartPanel },
];
