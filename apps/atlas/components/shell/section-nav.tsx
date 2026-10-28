"use client";

import { Icon } from "@xos/ui";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useState } from "react";

/**
 * The Settings template's section list (Section 4.5.6 order), marking the current section. Below md,
 * on a section's own page, the list collapses into a picker naming the current section, so the form
 * comes first instead of after forty links (A59-005); the picker expands the same list. The index
 * page, with no section open, already lists the sections in its content, so on a phone the rail
 * stays out of the way there.
 */
export function SectionNav({
  label,
  sections,
}: {
  label: string;
  sections: readonly { readonly id: string; readonly label: string; readonly href: string }[];
}) {
  const pathname = usePathname();
  const listId = useId();
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  // A deeper page (a member, a webhook) belongs to its section too.
  const current = sections.find((s) => pathname === s.href || pathname.startsWith(`${s.href}/`));
  return (
    <nav aria-label={label} className="flex flex-col gap-8">
      {current ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpenOn(open ? null : pathname)}
          className="flex h-control-md w-full cursor-pointer items-center justify-between gap-8 rounded-control border border-border-subtle bg-bg-surface px-12 text-start text-text-13 font-medium text-text-primary hover:bg-bg-hover md:hidden pointer-coarse:min-h-target-coarse"
        >
          <span className="truncate" title={current.label}>
            {current.label}
          </span>
          <span className={`inline-flex ${open ? "rotate-180" : ""}`}>
            <Icon name="ChevronDown" size={14} />
          </span>
        </button>
      ) : null}
      <ul
        id={listId}
        className={`m-0 flex list-none flex-col gap-2 p-0 ${open ? "" : "max-md:hidden"}`}
      >
        {sections.map((s) => {
          const here = pathname === s.href;
          return (
            <li key={s.id}>
              <Link
                href={s.href as Route}
                aria-current={here ? "page" : undefined}
                className={`flex min-h-row-default items-center rounded-control px-8 text-text-13 hover:bg-bg-hover ${
                  here ? "bg-bg-hover font-medium text-text-primary" : "text-text-secondary"
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
