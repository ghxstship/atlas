import { listBreakTypes, type BreakType } from "@xos/data/crew";
import { ActionForm } from "@/components/platform/kit";
import { Checkbox, InlineAlert, Input } from "@/components/ui";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import { breakTypeAction } from "./b9-actions";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * B9's panel on Settings, Time and Attendance (RRR-233, Section 4.5.6 item 24, ADR 0148 decision 4): org-defined break
 * types, each paid or unpaid. A paid break is worked time, kept apart from break_minutes and never subtracted; state
 * break and meal rules stay deferred (ADR 0033 decision 54). Forms appear with org.time_attendance.write and row level
 * security decides each write. The add button is secondary: the page's save is its one primary action (gate 27).
 */

const P = "crew.breakTypes";
const ROW = "flex flex-col gap-8 rounded-card border border-border-subtle p-12";

function Fields({ t, idPrefix, type }: { t: Translate; idPrefix: string; type?: BreakType }) {
  return (
    <div className="flex flex-wrap items-end gap-12">
      <Input
        id={`${idPrefix}-name`}
        name="name"
        label={t(`${P}.name`)}
        defaultValue={type?.name ?? ""}
        maxLength={80}
        required
      />
      <Input
        id={`${idPrefix}-planned`}
        name="plannedMinutes"
        type="number"
        min={1}
        max={240}
        label={t(`${P}.plannedMinutes`)}
        help={t(`${P}.plannedHelp`)}
        defaultValue={type?.plannedMinutes === null || !type ? "" : String(type.plannedMinutes)}
      />
      <Checkbox
        id={`${idPrefix}-paid`}
        name="paid"
        label={t(`${P}.paid`)}
        defaultChecked={type?.paid ?? false}
      />
    </div>
  );
}

async function BreakTypesPanel({ ctx }: SettingsPanelProps) {
  const t = await getTranslate();
  const canEdit = ctx.capabilities.has("org.time_attendance.write");
  const types = await listBreakTypes(ctx.viewer.db, ctx.org.id);
  const org = ctx.org.slug;
  return (
    <section aria-labelledby="break-types" className="flex flex-col gap-12">
      <header className="flex flex-col gap-4">
        <h2 id="break-types" className="m-0 text-heading-16 font-semibold">
          {t(`${P}.title`)}
        </h2>
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.description`)}</p>
      </header>
      {!types.ok ? (
        <InlineAlert tone="danger">{t(`${P}.loadFailed`)}</InlineAlert>
      ) : types.data.length === 0 ? (
        <p className="m-0 text-text-13 text-text-secondary">{t(`${P}.empty`)}</p>
      ) : (
        <ul aria-label={t(`${P}.title`)} className="m-0 flex list-none flex-col gap-8 p-0">
          {types.data.map((b) => (
            <li key={b.id} className={ROW}>
              <div className="flex flex-wrap items-baseline justify-between gap-8">
                <span className="text-text-14 font-semibold">{b.name}</span>
                <span className="text-text-12 text-text-secondary">
                  {[
                    t(`${P}.${b.paid ? "paidLabel" : "unpaidLabel"}`),
                    ...(b.plannedMinutes === null
                      ? []
                      : [t(`${P}.planned`, { minutes: b.plannedMinutes })]),
                    ...(b.isDefault ? [t(`${P}.default`)] : []),
                  ].join(" · ")}
                </span>
              </div>
              {canEdit ? (
                <div className="flex flex-wrap items-center gap-8">
                  <details className="w-full">
                    <summary className="cursor-pointer text-text-13 text-accent-text">
                      {t(`${P}.edit`, { name: b.name })}
                    </summary>
                    <div className="pt-8">
                      <ActionForm
                        action={breakTypeAction}
                        hidden={{ org, intent: "update", id: b.id }}
                        label={t(`${P}.edit`, { name: b.name })}
                        submitLabel={t(`${P}.save`)}
                        submitVariant="secondary"
                        success={t(`${P}.saved`)}
                      >
                        <Fields t={t} idPrefix={`break-${b.id}`} type={b} />
                      </ActionForm>
                    </div>
                  </details>
                  {b.isDefault ? null : (
                    <ActionForm
                      action={breakTypeAction}
                      hidden={{ org, intent: "default", id: b.id }}
                      label={t(`${P}.makeDefault`, { name: b.name })}
                      submitLabel={t(`${P}.makeDefault`, { name: b.name })}
                      submitVariant="ghost"
                      inline
                    />
                  )}
                  <ActionForm
                    action={breakTypeAction}
                    hidden={{ org, intent: "retire", id: b.id }}
                    label={t(`${P}.retire`, { name: b.name })}
                    submitLabel={t(`${P}.retire`, { name: b.name })}
                    submitVariant="ghost"
                    inline
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {types.ok && types.data.length > 0 ? (
        <p className="m-0 text-text-12 text-text-secondary">{t(`${P}.defaultHelp`)}</p>
      ) : null}
      {canEdit ? (
        <div className="flex flex-col gap-8">
          <h3 className="m-0 text-text-14 font-semibold">{t(`${P}.addTitle`)}</h3>
          <ActionForm
            action={breakTypeAction}
            hidden={{ org, intent: "create" }}
            label={t(`${P}.addTitle`)}
            submitLabel={t(`${P}.add`)}
            success={t(`${P}.added`)}
            submitVariant="secondary"
          >
            <Fields t={t} idPrefix="break-new" />
          </ActionForm>
        </div>
      ) : (
        <p className="m-0 text-text-12 text-text-secondary">{t(`${P}.readOnly`)}</p>
      )}
    </section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.time-and-attendance", order: 30, Panel: BreakTypesPanel },
];
