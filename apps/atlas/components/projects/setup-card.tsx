import { summarizeSetup, type SetupItem } from "@xos/data/setup";
import type { Route } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

/**
 * The Overview's Setup card (B14, G-266): how far the project's event type requirements are met, as a native meter
 * and the items still missing, each with the gate it is needed by. Server-rendered markup only, so the Overview (a
 * key page) carries no JavaScript for it. Nothing renders for an untyped project or a reader who cannot see its
 * documents (app.project_setup_progress is empty then).
 */
export async function SetupCard({
  items,
  gatesHref,
}: {
  items: readonly SetupItem[];
  gatesHref: string;
}) {
  if (items.length === 0) return null;
  const t = await getTranslations("projects");
  const { required, recommended } = summarizeSetup(items);
  const missing = items.filter((i) => !i.satisfied);
  return (
    <section aria-labelledby="project-setup" className="flex flex-col gap-8">
      <h2 id="project-setup" className="m-0 text-heading-16 font-semibold">
        {t("setup.title")}
      </h2>
      <label className="flex flex-col gap-4 text-text-13">
        <span>
          {t("setup.summary", {
            requiredMet: required.met,
            requiredTotal: required.total,
            recommendedMet: recommended.met,
            recommendedTotal: recommended.total,
          })}
        </span>
        <meter
          min={0}
          max={Math.max(required.total, 1)}
          value={required.met}
          className="w-full max-w-layout-form"
        >
          {required.met} / {required.total}
        </meter>
      </label>
      {missing.length > 0 ? (
        <ul className="m-0 flex list-disc flex-col gap-4 ps-20 text-text-13">
          {missing.map((i) => (
            <li key={i.requirementId}>
              {t("setup.itemLine", {
                label: i.label,
                requirement:
                  i.requirement === "Required" ? t("setup.required") : t("setup.recommended"),
                gate: i.requiredByGate,
              })}
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 text-text-13 text-text-secondary">{t("setup.complete")}</p>
      )}
      <p className="m-0">
        <Link href={gatesHref as Route} className="text-text-13 text-accent-text underline">
          {t("overview.openGates")}
        </Link>
      </p>
    </section>
  );
}
