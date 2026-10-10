"use client";

import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** The Settings template's section list (Section 4.5.6 order), marking the current section. */
export function SectionNav({
  label,
  sections,
}: {
  label: string;
  sections: readonly { readonly id: string; readonly label: string; readonly href: string }[];
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={label}>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {sections.map((s) => {
          const current = pathname === s.href;
          return (
            <li key={s.id}>
              <Link
                href={s.href as Route}
                aria-current={current ? "page" : undefined}
                className={`flex min-h-row-default items-center rounded-control px-8 text-text-13 hover:bg-bg-hover ${
                  current ? "bg-bg-hover font-medium text-text-primary" : "text-text-secondary"
                }`}
              >
                {s.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
