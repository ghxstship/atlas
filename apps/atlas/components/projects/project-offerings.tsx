import { listSettingValues, type StoredSettingValue } from "@xos/data/settings";
import { SETTINGS, type SettingDefinition } from "@xos/schemas/settings";
import { SettingsForm, type SettingFieldProps } from "@/components/settings/setting-field";
import { InlineAlert } from "@/components/ui";
import type { ProjectContext } from "@/lib/projects/context";
import { choiceLabelKey, formText } from "@/lib/settings/registry";
import { getTranslate, type Translate } from "@/lib/shell/translate";
import { OfferingRules } from "./offering-rules";

/**
 * Project Settings, Offerings (R3, owner decision 7): the project's own values of the offerings and
 * advancing settings, the first project-scope settings form, and the project's audience rules.
 * Each field shows the project value, else the org value, else the platform default (Not Offered
 * for every offering), says where it comes from, and is read-only where the org locked its value.
 * Values save through the settings form; rules through the offering rule actions. Both need
 * projects.settings.write, which the database checks again.
 */

const O = "projects.settings.offerings";

/** Settings the panel shows: project-scope keys under `offerings.` or `advancing.`, in registry order. */
export function projectOfferingSettings(): SettingDefinition[] {
  return SETTINGS.filter(
    (s) =>
      s.scopes.includes("project") &&
      (s.key.startsWith("offerings.") || s.key.startsWith("advancing.")),
  );
}

/** One field of the form: the project value, else the org value, else the default, and its source. */
export function projectOfferingField(
  t: Translate,
  def: SettingDefinition,
  stored: readonly StoredSettingValue[],
  projectId: string,
  canEdit: boolean,
): SettingFieldProps {
  const here = stored.find(
    (v) => v.key === def.key && v.scopeKind === "Project" && v.scopeId === projectId,
  );
  const org = stored.find((v) => v.key === def.key && v.scopeKind === "Organization");
  const orgLocked = org?.locked === true;
  const shown = orgLocked ? org : (here ?? org);
  const initial = shown ? formText(shown.value) : def.default === null ? "" : formText(def.default);
  const source = here ? "Project" : org ? "Organization" : "Default";
  return {
    def,
    label: t(def.label),
    help: def.help ? t(def.help) : null,
    options:
      def.type === "choice"
        ? def.choices.map((c) => ({ value: c, label: t(choiceLabelKey(def.key, c)) }))
        : [],
    initial,
    sourceText: orgLocked
      ? t("settings.source.organizationLocked")
      : t(`settings.source.project${source}`),
    setHere: here !== undefined && !orgLocked,
    locked: false,
    lockedByOrg: orgLocked,
    canEdit,
  };
}

export async function ProjectOfferings({ ctx }: { ctx: ProjectContext }) {
  const t = await getTranslate();
  const db = ctx.org.viewer.db;
  const stored = await listSettingValues(db, ctx.org.org.id);
  if (!stored.ok) return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  const canEdit = ctx.capabilities.has("projects.settings.write");
  return (
    <section
      aria-labelledby="project-offerings"
      className="flex max-w-layout-form flex-col gap-12"
      data-testid="project-offerings"
    >
      <header className="flex flex-col gap-4">
        <h2 id="project-offerings" className="m-0 text-heading-16 font-semibold">
          {t(`${O}.title`)}
        </h2>
        <p className="m-0 text-text-13 text-text-secondary">{t(`${O}.description`)}</p>
      </header>
      <SettingsForm
        org={ctx.org.org.slug}
        group="org"
        label={t(`${O}.fieldsLabel`)}
        scopeKind="Project"
        scopeId={ctx.project.id}
        fields={projectOfferingSettings().map((def) =>
          projectOfferingField(t, def, stored.data, ctx.project.id, canEdit),
        )}
      />
      <h3 id="project-offering-rules" className="m-0 text-heading-14 font-semibold">
        {t(`${O}.rules`)}
      </h3>
      <p className="m-0 text-text-13 text-text-secondary">{t(`${O}.rulesDescription`)}</p>
      <OfferingRules
        t={t}
        db={db}
        orgId={ctx.org.org.id}
        scope={{ org: ctx.org.org.slug, projectId: ctx.project.id, projectKey: ctx.project.key }}
        canEdit={canEdit}
        headingId="project-offering-rules"
      />
    </section>
  );
}
