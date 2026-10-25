import { getStandardLibraryStatus, isFullyAdopted } from "@xos/data/standard-library";
import { getTranslations } from "next-intl/server";
import { ActionForm } from "@/components/operations/action-form";
import { InlineAlert } from "@/components/ui";
import { adoptStandardLibraryAction } from "./wp18-actions";
import type { SettingsContribution, SettingsPanelProps } from "./types";

/**
 * WP18's settings panel (finding A65-027, Section 7.2): Settings, Canon Extensions shows, per Standard Library
 * table, how many standard rows the org holds a copy of, and offers "Adopt Standard Library" to an org created
 * before new orgs received their copy (migration 1612). Adopting copies only what the org never held, so it
 * never overwrites an edit and can run again. Reads with the viewer's client: the status needs
 * org.settings.read and adopting needs canon.extension.write, both checked by the database.
 */
async function StandardLibraryPanel({ ctx }: SettingsPanelProps) {
  if (!ctx.capabilities.has("org.settings.read")) return null;
  const [t, status] = await Promise.all([
    getTranslations("settings.standardLibrary"),
    getStandardLibraryStatus(ctx.viewer.db, ctx.org.id),
  ]);
  const canAdopt = ctx.capabilities.has("canon.extension.write");
  const complete = status.ok && isFullyAdopted(status.data);
  const partial = status.ok && !complete && status.data.some((c) => c.adoptedCount > 0);
  return (
    <section
      aria-labelledby="standard-library"
      className="flex flex-col gap-12"
      data-testid="standard-library"
    >
      <header className="flex flex-col gap-4">
        <h2 id="standard-library" className="m-0 text-heading-16 font-semibold">
          {t("title")}
        </h2>
        <p className="m-0 text-text-secondary">{t("description")}</p>
      </header>
      {!status.ok ? (
        <InlineAlert tone="danger">{t("loadError")}</InlineAlert>
      ) : (
        <>
          {/* A labelled, focusable region, so keyboard users can scroll the table sideways. */}
          <div role="region" aria-label={t("title")} tabIndex={0} className="overflow-x-auto">
            <table className="w-full border-collapse text-text-13">
              <caption className="sr-only">{t("title")}</caption>
              <thead>
                <tr className="text-text-12 text-text-secondary">
                  <th scope="col" className="py-6 pe-12 text-start font-medium">
                    {t("libraryLabel")}
                  </th>
                  <th scope="col" className="py-6 text-end font-medium">
                    {t("heldLabel")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {status.data.map((c) => (
                  <tr key={c.library} className="border-t border-border-subtle">
                    <th scope="row" className="py-6 pe-12 text-start font-medium">
                      {t(`libraries.${c.library}`)}
                    </th>
                    <td className="py-6 text-end tabular-nums">
                      {t("held", { adopted: c.adoptedCount, standard: c.standardCount })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {complete ? (
            <p className="m-0 text-text-13 text-success-text">{t("complete")}</p>
          ) : (
            <>
              {partial ? (
                <p className="m-0 text-text-12 text-text-secondary">{t("skipped")}</p>
              ) : null}
              {canAdopt ? (
                <div className="flex flex-col gap-8">
                  <p className="m-0 text-text-13 text-text-secondary">{t("adoptHelp")}</p>
                  <ActionForm
                    action={adoptStandardLibraryAction}
                    hidden={{ org: ctx.org.slug }}
                    submitLabel={t("adopt")}
                    successKey="settings.standardLibrary.copied"
                  />
                </div>
              ) : (
                <p className="m-0 text-text-12 text-text-secondary">{t("manageOnly")}</p>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

export const contributions: readonly SettingsContribution[] = [
  { node: "settings.canon-extensions", order: 40, Panel: StandardLibraryPanel },
];
