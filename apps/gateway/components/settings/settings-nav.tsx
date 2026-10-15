"use client";

import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";

/** The settings section list; on phones it scrolls sideways above the form. */
export function SettingsNav({
  label,
  groups,
}: {
  label: string;
  groups: readonly {
    label: string;
    items: readonly { id: string; label: string; href: string }[];
  }[];
}) {
  const pathname = usePathname();
  return (
    <nav aria-label={label} className="flex flex-col gap-16">
      {groups.map((g) => (
        <div key={g.label} className="flex flex-col gap-4">
          <h2 className="m-0 px-8 text-text-12 font-semibold text-text-secondary">{g.label}</h2>
          <ul className="m-0 flex list-none flex-col p-0 max-md:flex-row max-md:flex-wrap max-md:gap-4">
            {g.items.map((item) => {
              const current = pathname === item.href;
              return (
                <li key={item.id}>
                  <Link
                    href={item.href as Route}
                    aria-current={current ? "page" : undefined}
                    className="flex min-h-touch-min items-center rounded-control px-8 text-text-13 text-text-secondary no-underline hover:bg-bg-hover aria-[current=page]:bg-bg-hover aria-[current=page]:font-medium aria-[current=page]:text-text-primary"
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
