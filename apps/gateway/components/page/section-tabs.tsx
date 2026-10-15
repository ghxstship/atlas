import type { Route } from "next";
import Link from "next/link";

/** Link tabs: each tab is a page with its own URL, so back, refresh and sharing work. */
export function SectionTabs({
  label,
  tabs,
  active,
}: {
  label: string;
  tabs: readonly { readonly id: string; readonly label: string; readonly href: string }[];
  active: string;
}) {
  return (
    <nav
      aria-label={label}
      className="-mx-16 overflow-x-auto px-16 [scrollbar-width:none] md:mx-0 md:px-0"
    >
      <ul className="m-0 flex list-none gap-16 border-b border-border-subtle p-0">
        {tabs.map((tab) => {
          const current = tab.id === active;
          return (
            <li key={tab.id} className="flex-none">
              <Link
                href={tab.href as Route}
                aria-current={current ? "page" : undefined}
                className={`relative inline-flex min-h-touch-min items-center whitespace-nowrap py-8 text-text-14 font-medium no-underline ${
                  current
                    ? "text-text-primary after:absolute after:inset-x-0 after:-bottom-px after:h-(--stroke-width-accent) after:bg-accent"
                    : "text-text-secondary hover:text-text-primary"
                }`}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
