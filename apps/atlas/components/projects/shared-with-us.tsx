import type { SharedProject } from "@xos/data/access-controls";
import { getTranslations } from "next-intl/server";
import { enumKey } from "@/lib/projects/format";
import { getTranslate } from "@/lib/shell/translate";

/**
 * Projects other organizations share with the viewer's org (Section 8.5, migration 1205), below the
 * Projects list. It shows only the projection a share opens: the owner, key, name, dates and the
 * project role partner members hold. Server-rendered, with no client script.
 */
export async function SharedWithUs({ shared }: { shared: readonly SharedProject[] }) {
  if (shared.length === 0) return null;
  const t = await getTranslate();
  const tp = await getTranslations("projects");
  return (
    <section aria-labelledby="shared-with-us" className="flex flex-col gap-8 px-24 pb-24">
      <h2 id="shared-with-us" className="m-0 text-heading-16 font-semibold">
        {t("settings.accessControls.sharedWithUs.title")}
      </h2>
      <ul className="m-0 flex list-none flex-col divide-y divide-border-subtle p-0">
        {shared.map((s) => (
          <li key={s.shareId} className="flex flex-col gap-2 py-8">
            <span className="text-text-14 text-text-primary">
              <span className="font-mono">{s.projectKey}</span> {s.name}
            </span>
            <span className="text-text-12 text-text-secondary">
              {t("settings.accessControls.sharedWithUs.entry", {
                owner: s.ownerOrgName,
                role: tp(`roles.${enumKey(s.projectRole)}` as "roles.field"),
              })}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
