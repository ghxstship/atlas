import type { Route } from "next";
import Link from "next/link";
import {
  AccessGridSection,
  CategoriesSection,
  IssuedSection,
  ScanLogSection,
} from "@/components/credentials/sections";
import { hrefWith, param } from "@/components/operations/kit";
import { loadProjectTab } from "@/lib/operations/context";

const SECTIONS = [
  { value: "issued", label: "nav.atlas.pages.credentials.issued" },
  { value: "categories", label: "nav.atlas.pages.credentials.categories" },
  { value: "access-grid", label: "nav.atlas.pages.credentials.accessGrid" },
  { value: "scan-log", label: "nav.atlas.pages.credentials.scanLog" },
] as const;

/**
 * The project's Credentials tab (Section 4.5.4): categories, issued credentials, the access grid and
 * the scan log of one project, through the same sections as the org pages with the project fixed.
 */
export default async function Page({
  params,
  searchParams,
}: PageProps<"/[org]/p/[projectKey]/credentials">) {
  const page = await loadProjectTab("project.credentials", await params, await searchParams);
  const requested = param(page.search, "section");
  const section = SECTIONS.find((s) => s.value === requested)?.value ?? "issued";
  return (
    <>
      <nav aria-label={page.t("credentials.common.sections")}>
        <ul className="m-0 flex list-none flex-wrap gap-4 border-b border-border-subtle p-0">
          {SECTIONS.map((s) => (
            <li key={s.value}>
              <Link
                href={hrefWith(page.base, {}, { section: s.value }) as Route}
                aria-current={s.value === section ? "page" : undefined}
                className="flex min-h-control-md items-center border-b-2 border-transparent px-12 text-label-13 text-text-secondary hover:text-text-primary aria-[current=page]:border-accent aria-[current=page]:text-text-primary"
              >
                {page.t(s.label)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {section === "categories" ? (
        <CategoriesSection page={page} />
      ) : section === "access-grid" ? (
        <AccessGridSection page={page} />
      ) : section === "scan-log" ? (
        <ScanLogSection page={page} />
      ) : (
        <IssuedSection page={page} />
      )}
    </>
  );
}
