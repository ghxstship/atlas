import Link from "next/link";
import type { Route } from "next";
import { advancingProjectTab } from "@/components/advancing/context";
import { PacketsCollection } from "@/components/advancing/packets";
import { ReconciliationCollection } from "@/components/advancing/reconciliation";
import { RidersCollection } from "@/components/advancing/riders";
import { GuestList } from "@/components/advancing/guests";
import { flatSearch } from "@/components/advancing/shared";
import { SubmissionsSplit } from "@/components/advancing/submissions";
import { getTranslate } from "@/lib/shell/translate";

const SECTIONS = ["packets", "submissions", "riders", "reconciliation", "guests"] as const;

/**
 * The project's Advancing tab (Section 4.5.4): packets, submissions, riders and reconciliation of
 * this project, using the same components as the org-level pages with the project fixed.
 */
export default async function ProjectAdvancingPage({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/advancing">) {
  const routeParams = await params;
  const search = flatSearch(await searchParams);
  const actx = await advancingProjectTab(routeParams);
  const t = await getTranslate();
  const section = SECTIONS.find((s) => s === search["section"]) ?? "packets";
  const path = `/${routeParams.org}/p/${routeParams.projectKey}/advancing`;
  const sectionHref = (s: string) => `${path}?section=${s}`;
  const sectionLabel = (s: string) =>
    s === "guests" ? t("advancing.guests.title") : t(`nav.atlas.pages.advancing.${s}`);
  const title = sectionLabel(section);
  return (
    <div className="flex flex-col gap-16 min-w-0">
      <p className="m-0 text-text-13 text-text-secondary">
        {t("advancing.projectTab.scope", { key: actx.project.key, name: actx.project.name })}
      </p>
      <nav aria-label={t("advancing.projectTab.sections")}>
        <ul className="m-0 flex list-none flex-wrap gap-4 border-b border-border-subtle p-0">
          {SECTIONS.map((s) => (
            <li key={s}>
              <Link
                href={sectionHref(s) as Route}
                aria-current={s === section ? "page" : undefined}
                className="inline-flex min-h-target-coarse items-center border-b-2 border-transparent px-12 text-text-13 text-text-secondary hover:text-text-primary aria-[current=page]:border-accent aria-[current=page]:text-text-primary"
              >
                {sectionLabel(s)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {section === "guests" ? (
        <GuestList actx={actx} project={actx.project} path={path} search={search} title={title} />
      ) : section === "submissions" ? (
        <SubmissionsSplit
          actx={actx}
          path={path}
          search={search}
          title={title}
          packetsHref={sectionHref("packets")}
        />
      ) : section === "riders" ? (
        <RidersCollection actx={actx} path={path} search={search} title={title} />
      ) : section === "reconciliation" ? (
        <ReconciliationCollection
          actx={actx}
          path={path}
          search={search}
          title={title}
          ridersHref={sectionHref("riders")}
        />
      ) : (
        <PacketsCollection actx={actx} path={path} search={search} title={title} />
      )}
    </div>
  );
}
