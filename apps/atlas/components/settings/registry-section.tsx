import { listSettingValues, resolveSettings, type StoredSettingValue } from "@xos/data/settings";
import { listWorkspaces } from "@xos/data";
import type { SettingDefinition } from "@xos/schemas/settings";
import { InlineAlert } from "@/components/ui";
import { choiceLabelKey, formText, pageSettings } from "@/lib/settings/registry";
import type { OrgContext } from "@/lib/shell/context";
import { getTranslate } from "@/lib/shell/translate";
import { SettingField, type SettingFieldProps } from "./setting-field";

type Translate = Awaited<ReturnType<typeof getTranslate>>;

/** Option lists for settings whose text comes from a reference list. */
export async function referenceOptions(
  ctx: OrgContext,
  defs: readonly SettingDefinition[],
): Promise<Map<string, { value: string; label: string }[]>> {
  const out = new Map<string, { value: string; label: string }[]>();
  for (const def of defs) {
    if (def.input === "time_zone") {
      out.set(
        def.key,
        ["UTC", ...Intl.supportedValuesOf("timeZone").filter((z) => z !== "UTC")].map((z) => ({
          value: z,
          label: z.replaceAll("_", " "),
        })),
      );
    } else if (def.input === "currency") {
      const { data, error } = await ctx.viewer.db.from("currencies").select("currency_code");
      if (error) throw new Error(`Cannot read currencies: ${error.message}`);
      out.set(
        def.key,
        data.flatMap((c) =>
          c.currency_code ? [{ value: c.currency_code, label: c.currency_code }] : [],
        ),
      );
    } else if (def.input === "workspace") {
      const workspaces = await listWorkspaces(ctx.viewer.db, ctx.org.id);
      if (!workspaces.ok)
        throw new Error(`Cannot list workspaces: ${JSON.stringify(workspaces.error)}`);
      out.set(
        def.key,
        workspaces.data.map((w) => ({ value: w.id, label: w.name })),
      );
    }
  }
  return out;
}

function options(
  def: SettingDefinition,
  refs: Map<string, { value: string; label: string }[]>,
  t: Translate,
) {
  if (def.type === "choice") {
    return def.choices.map((c) => ({ value: c, label: t(choiceLabelKey(def.key, c)) }));
  }
  return refs.get(def.key) ?? [];
}

function defaultText(def: SettingDefinition): string {
  return def.default === null ? "" : formText(def.default);
}

/**
 * The registered settings of one settings page (Section 4.5.6), each showing where its value
 * comes from. On org pages it edits the org value and its lock; on personal pages it edits the
 * person's own value, and a value the org locked shows as locked.
 */
export async function RegistrySection({
  ctx,
  node,
  group,
}: {
  ctx: OrgContext;
  node: string;
  group: "org" | "personal";
}) {
  const defs = pageSettings(node, group);
  if (defs.length === 0) return null;
  const [t, resolved, stored, refs] = await Promise.all([
    getTranslate(),
    resolveSettings(ctx.viewer.db, { orgId: ctx.org.id }),
    listSettingValues(ctx.viewer.db, ctx.org.id),
    referenceOptions(ctx, defs),
  ]);
  if (!resolved.ok || !stored.ok) {
    return <InlineAlert tone="danger">{t("settings.loadFailed")}</InlineAlert>;
  }
  const orgValue = new Map<string, StoredSettingValue>(
    stored.data.filter((v) => v.scopeKind === "Organization").map((v) => [v.key, v]),
  );

  const fields: SettingFieldProps[] = defs.map((def) => {
    const own = orgValue.get(def.key);
    const r = resolved.data.get(def.key);
    const common = {
      org: ctx.org.slug,
      group,
      def,
      label: t(def.label),
      help: def.help ? t(def.help) : null,
      options: options(def, refs, t),
    };
    if (group === "org") {
      return {
        ...common,
        initial: own ? formText(own.value) : defaultText(def),
        sourceText: own
          ? own.locked
            ? t("settings.source.organizationLocked")
            : t("settings.source.organization")
          : t("settings.source.default"),
        setHere: own !== undefined,
        locked: own?.locked ?? false,
        lockedByOrg: false,
        canEdit: ctx.capabilities.has(def.capability),
      };
    }
    const lockedByOrg = own?.locked === true;
    const source = r?.source ?? "Default";
    return {
      ...common,
      initial: r ? formText(r.value) : defaultText(def),
      sourceText: lockedByOrg
        ? t("settings.source.lockedForYou", { org: ctx.org.name })
        : t(`settings.source.personal${source}`),
      setHere: source === "Personal",
      locked: false,
      lockedByOrg,
      canEdit: true,
      ...(def.key === "me.persona" ? { perOrg: true } : {}),
    };
  });

  return (
    <section aria-label={t("settings.registryHeading")} className="flex max-w-layout-form flex-col">
      <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
        {fields.map((f) => (
          <li key={f.def.key}>
            {/* Keyed by the saved value: React resets a form after its action, so the
                controls remount with the new value as their default. */}
            <SettingField key={`${f.initial}:${String(f.locked)}`} {...f} />
          </li>
        ))}
      </ul>
    </section>
  );
}
